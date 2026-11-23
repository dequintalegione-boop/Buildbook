import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Durable inbox for Telegram updates received by the local Buildbook host.
 *
 * This module deliberately does not create financial records. An item may only be
 * marked complete after the canonical Buildbook storage adapter commits its effect.
 */
export function createInboxStore(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new TypeError('A durable inbox file path is required.');
  }

  const path = resolve(filePath);
  let statePromise;
  let writeChain = Promise.resolve();

  const emptyState = () => ({ version: 1, items: [] });

  async function load() {
    if (!statePromise) {
      statePromise = (async () => {
        try {
          const parsed = JSON.parse(await readFile(path, 'utf8'));
          if (parsed?.version !== 1 || !Array.isArray(parsed.items)) {
            throw new Error('Unsupported or corrupt Telegram inbox file.');
          }
          return parsed;
        } catch (error) {
          if (error.code === 'ENOENT') return emptyState();
          throw error;
        }
      })();
    }
    return statePromise;
  }

  async function persist(state) {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = path + '.' + randomUUID() + '.tmp';
    await writeFile(temporaryPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, path);
  }

  function mutate(change) {
    const operation = writeChain.then(async () => {
      const state = await load();
      const result = await change(state);
      await persist(state);
      return result;
    });
    writeChain = operation.catch(() => {});
    return operation;
  }

  return Object.freeze({
    async enqueue({ botId, updateId, userId, update }) {
      const keyParts = [String(botId ?? '').trim(), String(updateId ?? '')];
      if (!keyParts[0] || !/^\d+$/.test(keyParts[1])) {
        throw new TypeError('botId and a numeric Telegram updateId are required.');
      }
      if (!/^\d+$/.test(String(userId ?? ''))) {
        throw new TypeError('A numeric Telegram userId is required.');
      }
      if (update === undefined) throw new TypeError('The Telegram update payload is required.');
      const key = keyParts.join(':');

      return mutate(state => {
        const existing = state.items.find(item => item.key === key);
        if (existing) return { inserted: false, item: structuredClone(existing) };
        const item = {
          id: randomUUID(),
          key,
          botId: keyParts[0],
          updateId: Number(keyParts[1]),
          userId: String(userId),
          update: structuredClone(update),
          status: 'pending',
          attempts: 0,
          receivedAt: new Date().toISOString(),
          processedAt: null,
          lastError: null
        };
        state.items.push(item);
        return { inserted: true, item: structuredClone(item) };
      });
    },

    async nextPending() {
      const state = await load();
      const item = state.items.find(entry => entry.status === 'pending');
      return item ? structuredClone(item) : null;
    },

    async markProcessing(id) {
      return mutate(state => {
        const item = state.items.find(entry => entry.id === id);
        if (!item || item.status !== 'pending') return false;
        item.status = 'processing';
        item.attempts += 1;
        item.lastError = null;
        return true;
      });
    },

    async markPending(id, errorMessage) {
      return mutate(state => {
        const item = state.items.find(entry => entry.id === id);
        if (!item || item.status === 'completed') return false;
        item.status = 'pending';
        item.lastError = String(errorMessage || 'Processing failed').slice(0, 1000);
        return true;
      });
    },

    async markCompleted(id, operationId) {
      return mutate(state => {
        const item = state.items.find(entry => entry.id === id);
        if (!item) return false;
        if (item.status === 'completed') return true;
        item.status = 'completed';
        item.operationId = operationId == null ? null : String(operationId);
        item.processedAt = new Date().toISOString();
        item.lastError = null;
        return true;
      });
    },

    async recoverInterrupted() {
      return mutate(state => {
        let recovered = 0;
        for (const item of state.items) {
          if (item.status === 'processing') {
            item.status = 'pending';
            recovered += 1;
          }
        }
        return recovered;
      });
    },

    async stats() {
      const state = await load();
      const result = { total: state.items.length, pending: 0, processing: 0, completed: 0 };
      for (const item of state.items) {
        if (Object.hasOwn(result, item.status)) result[item.status] += 1;
      }
      return result;
    }
  });
}
