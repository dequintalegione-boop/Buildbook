import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_UPDATE_BYTES = 16 * 1024;

/**
 * Durable inbox for Telegram updates received by the local Buildbook host.
 *
 * This module deliberately does not create financial records. An item may only be
 * marked complete after the canonical Buildbook storage adapter commits its effect.
 * Completed items retain their idempotency metadata but discard raw Telegram content.
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
    try {
      // mode is applied when the temp file is created; rename then preserves
      // its restrictive permissions for the durable inbox, including updates.
      await writeFile(temporaryPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporaryPath, path);
    } catch (error) {
      // A failed write must not leave plaintext Telegram messages in a temp file.
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
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
      const numericUpdateId = Number(keyParts[1]);
      if (!/^\d{1,16}$/.test(keyParts[0]) || !/^\d+$/.test(keyParts[1])
        || !Number.isSafeInteger(numericUpdateId) || numericUpdateId < 0) {
        throw new TypeError('botId and a safe numeric Telegram updateId are required.');
      }
      if (!/^\d+$/.test(String(userId ?? ''))) {
        throw new TypeError('A numeric Telegram userId is required.');
      }
      if (!update || typeof update !== 'object' || Array.isArray(update)
        || update.update_id !== numericUpdateId) {
        throw new TypeError('The Telegram update payload must be an object matching updateId.');
      }
      let serializedUpdate;
      try { serializedUpdate = JSON.stringify(update); } catch {
        throw new TypeError('The Telegram update payload must be JSON-serializable.');
      }
      if (typeof serializedUpdate !== 'string' || Buffer.byteLength(serializedUpdate, 'utf8') > MAX_UPDATE_BYTES) {
        throw new TypeError('The Telegram update payload exceeds the allowed size.');
      }
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
        // Financial effects are committed by now; remove raw chat text and
        // attachments from the durable inbox while preserving dedupe metadata.
        item.update = null;
        item.payloadPurgedAt = item.processedAt;
        return true;
      });
    },

    async markRejected(id, errorMessage) {
      return mutate(state => {
        const item = state.items.find(entry => entry.id === id);
        if (!item || item.status === 'completed') return false;
        item.status = 'rejected';
        item.lastError = String(errorMessage || 'Invalid inbox item').slice(0, 1000);
        item.rejectedAt = new Date().toISOString();
        item.update = null;
        item.payloadPurgedAt = item.rejectedAt;
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
      const result = { total: state.items.length, pending: 0, processing: 0, completed: 0, rejected: 0 };
      for (const item of state.items) {
        if (Object.hasOwn(result, item.status)) result[item.status] += 1;
      }
      return result;
    }
  });
}
