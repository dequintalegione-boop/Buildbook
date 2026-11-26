import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_LIMIT = null; // No automatic retention: the plan requires preserving the full event history.

function normalizeEvent(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Activity event must be an object.');
  }
  const action = String(input.action || '').trim();
  const status = input.status === 'error' ? 'error' : input.status === 'success' ? 'success' : '';
  const message = String(input.message || '').trim();
  const telegramUserId = input.telegramUserId == null ? null : String(input.telegramUserId);
  const updateId = input.updateId == null ? null : input.updateId;
  const operationId = input.operationId == null ? null : String(input.operationId).trim();
  if (!/^[a-z0-9._-]{1,64}$/i.test(action) || !status || message.length > 200
    || /[\u0000-\u001f\u007f]/.test(message)
    || (telegramUserId !== null && (!/^[1-9]\d{0,15}$/.test(telegramUserId) || !Number.isSafeInteger(Number(telegramUserId))))
    || (updateId !== null && (!Number.isSafeInteger(updateId) || updateId < 0))
    || (operationId !== null && (!operationId || operationId.length > 256 || /[\u0000-\u001f\u007f]/.test(operationId)))) {
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
    ...(telegramUserId !== null ? { telegramUserId } : {}),
    ...(updateId !== null ? { updateId } : {}),
    ...(operationId !== null ? { operationId } : {}),
  });
}

/**
 * Small persistent operational journal. It deliberately accepts only action
 * labels and safe summaries; callers must never pass tokens, request bodies,
 * message text, or filesystem paths.
 */
export function createActivityLog({ path, limit = DEFAULT_LIMIT, now = () => new Date() } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('Activity log path must be absolute.');
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000)) throw new RangeError('Activity log limit must be null (unlimited) or between 1 and 5000.');
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
          && typeof event.message === 'string');
        if (limit !== null) events = events.slice(-limit);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw new Error('Не удалось прочитать журнал действий локального хоста.');
      // A damaged optional journal must not prevent the local host or Telegram UI from working.
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
        events = [...events, event];
        if (limit !== null) events = events.slice(-limit);
        await persist();
        return event;
      });
    },
    recent(count = 100, offset = 0, filters = {}) {
      if (!Number.isSafeInteger(count) || count < 1 || count > 500 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000_000) {
        throw new RangeError('Activity log read limit must be between 1 and 500.');
      }
      if (!filters || typeof filters !== 'object' || Array.isArray(filters)
        || Object.keys(filters).some(key => !['search', 'status', 'action'].includes(key))) {
        throw new TypeError('Activity log filters contain invalid fields.');
      }
      const search = String(filters.search || '').trim().toLocaleLowerCase();
      const status = filters.status || 'all';
      const action = filters.action || 'all';
      if (search.length > 200 || /[\u0000-\u001f\u007f]/.test(search)
        || !['all', 'success', 'error'].includes(status)
        || (action !== 'all' && !/^[a-z0-9._-]{1,64}$/i.test(action))) {
        throw new TypeError('Activity log filters are invalid.');
      }
      return serialize(async () => {
        await load();
        const matching = events.slice().reverse().filter(event => {
          if (status !== 'all' && event.status !== status) return false;
          if (action !== 'all' && event.action !== action) return false;
          if (!search) return true;
          const searchable = [event.action, event.message, event.telegramUserId, event.updateId, event.operationId]
            .filter(value => value !== undefined && value !== null).join(' ').toLocaleLowerCase();
          return searchable.includes(search);
        });
        return matching.slice(offset, offset + count).map(event => ({ ...event }));
      });
    },
  });
}
