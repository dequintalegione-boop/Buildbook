import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * File-backed Telegram polling checkpoint. Persisting an offset acknowledges
 * all updates below it on Telegram's next getUpdates request, so callers must
 * only advance it after every accepted update has been durably enqueued.
 */
export function createTelegramOffsetStore(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new TypeError('A Telegram offset file path is required.');
  }
  let chain = Promise.resolve();

  const serialize = operation => {
    const result = chain.then(operation, operation);
    chain = result.catch(() => {});
    return result;
  };

  async function readOffset() {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      if (parsed?.version !== 1 || !(parsed.offset === null || Number.isSafeInteger(parsed.offset) && parsed.offset >= 0)) {
        throw new Error('Unsupported or corrupt Telegram offset file.');
      }
      return parsed.offset;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
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
          await writeFile(temporary, JSON.stringify({ version: 1, offset }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          await rename(temporary, filePath);
        } catch (error) {
          await import('node:fs/promises').then(fs => fs.unlink(temporary)).catch(() => {});
          throw error;
        }
        return offset;
      });
    },
  });
}
