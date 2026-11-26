import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_LIMIT = 500;

function normalizeEvent(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Activity event must be an object.');
  }
  const action = String(input.action || '').trim();
  const status = input.status === 'error' ? 'error' : input.status === 'success' ? 'success' : '';
  const message = String(input.message || '').trim();
  if (!/^[a-z0-9._-]{1,64}$/i.test(action) || !status || message.length > 200
    || /[\u0000-\u001f\u007f]/.test(message)) {
    throw new TypeError('Activity event contains invalid fields.');
  }
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError('Activity clock must return a valid Date.');
  }
  return Object.freeze({
    id: randomUUID(),
    at: date.toISOString(),
    action,
    status,
    message,
  });
}

/**
 * Small persistent operational journal. It deliberately accepts only action
 * labels and safe summaries; callers must never pass tokens, request bodies,
 * message text, or filesystem paths.
 */
export function createActivityLog({ path, limit = DEFAULT_LIMIT, now = () => new Date() } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('Activity log path must be absolute.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new RangeError('Activity log limit must be between 1 and 5000.');
  if (typeof now !== 'function') throw new TypeError('Activity clock must be a function.');
  const filePath = resolve(path);
  let events = [];
  let loaded = false;
  let queue = Promise.resolve();

  async function load() {
    if (loaded) return;
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      if (parsed?.version === 1 && Array.isArray(parsed.events)) {
        events = parsed.events.filter(event => event && typeof event.id === 'string'
          && typeof event.at === 'string' && typeof event.action === 'string'
          && (event.status === 'success' || event.status === 'error')
          && typeof event.message === 'string').slice(-limit);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('Не удалось прочитать журнал действий локального хоста.');
    }
    loaded = true;
  }

  async function persist() {
    await mkdir(dirname(filePath), { recursive: true });
    const temporary = filePath + '.' + randomUUID() + '.tmp';
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, events }, null, 2) + '\n', 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  function serialize(task) {
    const result = queue.then(task, task);
    queue = result.catch(() => {});
    return result;
  }

  return Object.freeze({
    record(input) {
      return serialize(async () => {
        await load();
        const event = normalizeEvent(input, now);
        events = [...events, event].slice(-limit);
        await persist();
        return event;
      });
    },
    recent(count = 100) {
      if (!Number.isSafeInteger(count) || count < 1 || count > 500) {
        throw new RangeError('Activity log read limit must be between 1 and 500.');
      }
      return serialize(async () => {
        await load();
        return events.slice(-count).reverse().map(event => ({ ...event }));
      });
    },
  });
}
