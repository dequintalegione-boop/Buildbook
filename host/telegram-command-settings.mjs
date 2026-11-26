import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_TELEGRAM_COMMAND_SETTINGS = Object.freeze({
  income: false,
  expense: false,
  stats: false,
  help: true,
});

const COMMAND_KEYS = Object.keys(DEFAULT_TELEGRAM_COMMAND_SETTINGS);

function normalizeSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !COMMAND_KEYS.includes(key))) {
    throw new TypeError('Telegram command settings contain invalid fields.');
  }
  const settings = {};
  for (const key of COMMAND_KEYS) {
    const value = input[key] === undefined ? DEFAULT_TELEGRAM_COMMAND_SETTINGS[key] : input[key];
    if (typeof value !== 'boolean') throw new TypeError('Telegram command settings must be boolean.');
    settings[key] = value;
  }
  return Object.freeze(settings);
}

export function createTelegramCommandSettingsStore(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('Telegram command settings path must be absolute.');
  const filePath = resolve(path);
  let queue = Promise.resolve();

  function serialize(task) {
    const result = queue.then(task, task);
    queue = result.catch(() => {});
    return result;
  }

  return Object.freeze({
    read() {
      return serialize(async () => {
        try {
          const data = JSON.parse(await readFile(filePath, 'utf8'));
          if (data?.version !== 1) throw new TypeError('Unsupported Telegram command settings version.');
          return normalizeSettings(data.commands);
        } catch (error) {
          if (error?.code === 'ENOENT') return normalizeSettings(DEFAULT_TELEGRAM_COMMAND_SETTINGS);
          throw error;
        }
      });
    },
    write(commands) {
      return serialize(async () => {
        const normalized = normalizeSettings(commands);
        await mkdir(dirname(filePath), { recursive: true });
        const temporary = filePath + '.' + randomUUID() + '.tmp';
        try {
          const handle = await open(temporary, 'wx', 0o600);
          try {
            await handle.writeFile(JSON.stringify({ version: 1, commands: normalized }, null, 2) + '\n', 'utf8');
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, filePath);
        } catch (error) {
          await rm(temporary, { force: true }).catch(() => {});
          throw error;
        }
        return normalized;
      });
    },
  });
}
