import { mkdir, rename, unlink, lstat, open } from 'node:fs/promises';
import { dirname, basename, join, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_PROFILE_BYTES = 32 * 1024 * 1024;

async function readUtf8Bounded(handle, maxBytes) {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new RangeError('BOUNDED_FILE_LIMIT');
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
}

/**
 * File-backed canonical profile store for the local Buildbook host.
 * One host process owns this file; browser clients must use its API rather than
 * opening the file or writing their own financial ledger.
 */
export function createProfileStore(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new TypeError('Не задан путь к файлу профиля.');
  }

  if (!isAbsolute(filePath)) throw new TypeError('Путь к файлу профиля должен быть абсолютным.');
  const target = resolve(filePath);
  let queue = Promise.resolve();

  const serialize = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };

  async function readDisk() {
    let pathInfo;
    try {
      pathInfo = await lstat(target);
    } catch (error) {
      // Only a genuinely absent canonical path means an empty profile.
      // Do not turn a path-swap/open failure into revision zero: that could
      // make a caller believe an existing profile is safe to initialize.
      if (error.code === 'ENOENT') return { version: 1, revision: 0, profile: null };
      throw error;
    }
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
      throw new Error('Файл профиля должен быть обычным файлом, не ссылкой или специальным объектом.');
    }
    const handle = await open(target, 'r');
    let text;
      try {
        const openedInfo = await handle.stat();
        // Compare the opened object to the path checked above. This closes the
        // lstat/read path-swap window on platforms without O_NOFOLLOW.
        if (!openedInfo.isFile() || openedInfo.dev !== pathInfo.dev || openedInfo.ino !== pathInfo.ino) {
          throw new Error('Файл профиля был заменён во время чтения; операция отклонена.');
        }
        if (openedInfo.size > MAX_PROFILE_BYTES + 1024) throw new RangeError('Файл профиля превышает допустимый размер.');
        try { text = await readUtf8Bounded(handle, MAX_PROFILE_BYTES + 1024); }
        catch (error) { if (error.message === 'BOUNDED_FILE_LIMIT') throw new RangeError('Файл профиля превышает допустимый размер.'); throw error; }
      } finally {
        await handle.close();
      }
      const parsed = JSON.parse(text);
      if (!parsed || parsed.version !== 1 || !Number.isSafeInteger(parsed.revision)
        || parsed.revision < 0 || !parsed.profile || typeof parsed.profile !== 'object' || Array.isArray(parsed.profile)) {
        throw new Error('Файл профиля Buildbook имеет неизвестный или повреждённый формат.');
      }
    return parsed;
  }

  async function writeDisk(value) {
    await mkdir(dirname(target), { recursive: true });
    const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    try {
      // Flush the complete temporary profile before the atomic rename. This
      // narrows the crash window where a successful write could still be only
      // in the OS page cache; the canonical path is never partially written.
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(value), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  return Object.freeze({
    async read() {
      return serialize(async () => {
        const current = await readDisk();
        return { revision: current.revision, profile: current.profile };
      });
    },

    async write(profile, expectedRevision) {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        throw new TypeError('Профиль должен быть объектом.');
      }
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new TypeError('Не задана корректная версия профиля.');
      }
      let serializedProfile;
      try { serializedProfile = JSON.stringify(profile); } catch {
        throw new TypeError('Профиль должен содержать только сериализуемые JSON-данные.');
      }
      if (typeof serializedProfile !== 'string' || Buffer.byteLength(serializedProfile, 'utf8') > MAX_PROFILE_BYTES) {
        throw new RangeError('Размер профиля превышает допустимые 32 MiB.');
      }
      return serialize(async () => {
        const current = await readDisk();
        if (current.revision !== expectedRevision) {
          const error = new Error('Профиль уже изменён другим клиентом. Обновите данные и повторите сохранение.');
          error.name = 'BuildbookStorageConflictError';
          error.code = 'BUILD_BOOK_STORAGE_CONFLICT';
          error.expectedRevision = expectedRevision;
          error.currentRevision = current.revision;
          throw error;
        }
        if (current.revision >= Number.MAX_SAFE_INTEGER) {
          throw new RangeError('Исчерпан диапазон ревизий профиля.');
        }
        const revision = current.revision + 1;
        await writeDisk({ version: 1, revision, profile: JSON.parse(serializedProfile) });
        return revision;
      });
    },
  });
}
