import { mkdir, rename, unlink, lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

async function readUtf8Bounded(handle, maxBytes) {
  const buffer = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) throw new Error('Telegram offset file exceeds the allowed size.');
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
}

/**
 * File-backed Telegram polling checkpoint. Persisting an offset acknowledges
 * all updates below it on Telegram's next getUpdates request, so callers must
 * only advance it after every accepted update has been durably enqueued.
 */
export function createTelegramOffsetStore(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new TypeError('A Telegram offset file path is required.');
  }
  if (!isAbsolute(filePath)) throw new TypeError('A Telegram offset path must be absolute.');
  filePath = resolve(filePath);
  let chain = Promise.resolve();

  const serialize = operation => {
    const result = chain.then(operation, operation);
    chain = result.catch(() => {});
    return result;
  };

  async function readOffset() {
    let pathInfo;
    try {
      pathInfo = await lstat(filePath);
    } catch (error) {
      // Only an absent path at the initial check means no checkpoint. An
      // ENOENT after lstat indicates a path race and must not reset progress.
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
      throw new Error('Telegram offset path must be a regular file, not a link or special file.');
    }
    const handle = await open(filePath, 'r');
    let text;
    try {
      const openedInfo = await handle.stat();
      if (!openedInfo.isFile() || openedInfo.dev !== pathInfo.dev || openedInfo.ino !== pathInfo.ino) {
        throw new Error('Telegram offset file changed during read; refusing the checkpoint.');
      }
      if (openedInfo.size > 1024) throw new Error('Telegram offset file exceeds the allowed size.');
      text = await readUtf8Bounded(handle, 1024);
    } finally {
      await handle.close();
    }
    const parsed = JSON.parse(text);
    if (parsed?.version !== 1 || !(parsed.offset === null || Number.isSafeInteger(parsed.offset) && parsed.offset >= 0)) {
      throw new Error('Unsupported or corrupt Telegram offset file.');
    }
    return parsed.offset;
  }

  return Object.freeze({
    read() {
      return serialize(readOffset);
    },
    write(offset) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Telegram offset must be a non-negative safe integer.');
      return serialize(async () => {
        const current = await readOffset();
        if (current !== null && offset < current) throw new Error('Telegram offset cannot move backwards.');
        await mkdir(dirname(filePath), { recursive: true });
        const temporary = filePath + '.' + randomUUID() + '.tmp';
        try {
          const handle = await open(temporary, 'wx', 0o600);
          try {
            await handle.writeFile(JSON.stringify({ version: 1, offset }), 'utf8');
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, filePath);
          // Persist the checkpoint's directory entry as well as its contents.
          // Otherwise a power loss after rename may roll back the acknowledged
          // offset on filesystems that defer directory metadata.
          if (process.platform !== 'win32') {
            const directoryHandle = await open(dirname(filePath), 'r');
            try {
              await directoryHandle.sync();
            } finally {
              await directoryHandle.close();
            }
          }
        } catch (error) {
          await unlink(temporary).catch(() => {});
          throw error;
        }
        return offset;
      });
    },
  });
}
