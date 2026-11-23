import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * File-backed canonical profile store for the local Buildbook host.
 * One host process owns this file; browser clients must use its API rather than
 * opening the file or writing their own financial ledger.
 */
export function createProfileStore(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new TypeError('Не задан путь к файлу профиля.');
  }

  const target = filePath;
  let queue = Promise.resolve();

  const serialize = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };

  async function readDisk() {
    try {
      const text = await readFile(target, 'utf8');
      const parsed = JSON.parse(text);
      if (!parsed || parsed.version !== 1 || !Number.isSafeInteger(parsed.revision)
        || parsed.revision < 0 || !parsed.profile || typeof parsed.profile !== 'object') {
        throw new Error('Файл профиля Buildbook имеет неизвестный или повреждённый формат.');
      }
      return parsed;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, revision: 0, profile: null };
      throw error;
    }
  }

  async function writeDisk(value) {
    await mkdir(dirname(target), { recursive: true });
    const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
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
        const revision = current.revision + 1;
        await writeDisk({ version: 1, revision, profile });
        return revision;
      });
    },
  });
}
