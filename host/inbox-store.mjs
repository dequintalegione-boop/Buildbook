import { mkdir, rename, rm, lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_UPDATE_BYTES = 16 * 1024;
const MAX_INBOX_FILE_BYTES = 64 * 1024 * 1024;

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

function safeInboxError(fallback) {
  return fallback === 'rejected'
    ? 'Telegram update rejected by command validation.'
    : 'Telegram update processing failed; retry scheduled.';
}

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

  if (!isAbsolute(filePath)) {
    throw new TypeError('A durable inbox file path must be absolute.');
  }
  const path = resolve(filePath);
  let statePromise;
  let writeChain = Promise.resolve();

  const emptyState = () => ({ version: 1, items: [] });

  function isValidItem(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const botId = item.botId;
    const userId = item.userId;
    if (typeof item.id !== 'string' || !item.id || item.id.length > 128
      || typeof botId !== 'string' || !/^\d{1,16}$/.test(botId)
      || !Number.isSafeInteger(Number(botId)) || Number(botId) <= 0
      || String(Number(botId)) !== botId
      || !Number.isSafeInteger(item.updateId) || item.updateId < 0 || item.updateId >= Number.MAX_SAFE_INTEGER
      || item.key !== botId + ':' + String(item.updateId)
      || typeof userId !== 'string' || !/^\d{1,16}$/.test(userId)
      || String(Number(userId)) !== userId || !Number.isSafeInteger(Number(userId)) || Number(userId) <= 0
      || !['pending', 'processing', 'completed', 'rejected'].includes(item.status)
      || !Number.isSafeInteger(item.attempts) || item.attempts < 0
      || typeof item.receivedAt !== 'string' || !Number.isFinite(Date.parse(item.receivedAt))
      || !(item.processedAt === null || typeof item.processedAt === 'string')
      || !(item.lastError === null || typeof item.lastError === 'string' && item.lastError.length <= 256)) return false;
    if (item.status === 'pending' || item.status === 'processing') {
      return !!item.update && typeof item.update === 'object' && !Array.isArray(item.update);
    }
    if (item.update !== null || typeof item.payloadPurgedAt !== 'string'
      || !Number.isFinite(Date.parse(item.payloadPurgedAt))) return false;
    if (item.status === 'completed') {
      return typeof item.operationId === 'string' && item.operationId.length > 0 && item.operationId.length <= 256
        && typeof item.processedAt === 'string' && Number.isFinite(Date.parse(item.processedAt));
    }
    return typeof item.rejectedAt === 'string' && Number.isFinite(Date.parse(item.rejectedAt));
  }

  function isValidState(value) {
    if (!value || value.version !== 1 || !Array.isArray(value.items)) return false;
    const ids = new Set();
    const keys = new Set();
    for (const item of value.items) {
      if (!isValidItem(item) || ids.has(item.id) || keys.has(item.key)) return false;
      ids.add(item.id);
      keys.add(item.key);
    }
    return true;
  }

  async function load() {
    if (!statePromise) {
      const pending = (async () => {
        let pathInfo;
        try {
          pathInfo = await lstat(path);
        } catch (error) {
          // An absent inbox at the initial path check is a valid empty queue.
          // A later ENOENT is a path race and must never discard queued updates.
          if (error.code === 'ENOENT') return emptyState();
          throw error;
        }
        if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
          throw new Error('Telegram inbox path must be a regular file, not a link or special file.');
        }
        const handle = await open(path, 'r');
        let text;
        try {
          const openedInfo = await handle.stat();
          if (!openedInfo.isFile() || openedInfo.dev !== pathInfo.dev || openedInfo.ino !== pathInfo.ino) {
            throw new Error('Telegram inbox file changed during read; refusing persisted updates.');
          }
          if (openedInfo.size > MAX_INBOX_FILE_BYTES) {
            throw new Error('Telegram inbox file exceeds the allowed size.');
          }
          try { text = await readUtf8Bounded(handle, MAX_INBOX_FILE_BYTES); }
          catch (error) {
            if (error.message === 'BOUNDED_FILE_LIMIT') throw new RangeError('Telegram inbox file exceeds the allowed size.');
            throw error;
          }
        } finally {
          await handle.close();
        }
        const parsed = JSON.parse(text);
        if (!isValidState(parsed)) {
          throw new Error('Unsupported or corrupt Telegram inbox file.');
        }
        return parsed;
      })();
      // A failed read must not permanently poison this store instance. Keep
      // the rejection visible to current callers, but allow a later operation
      // to retry after a transient I/O failure or an externally repaired file.
      const cached = pending.catch(error => {
        if (statePromise === cached) statePromise = undefined;
        throw error;
      });
      statePromise = cached;
    }
    return statePromise;
  }

  async function persist(state) {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = path + '.' + randomUUID() + '.tmp';
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_INBOX_FILE_BYTES) {
      throw new Error('Telegram inbox capacity reached; refusing an unsafe oversized write.');
    }
    try {
      // mode is applied when the temp file is created; rename then preserves
      // its restrictive permissions for the durable inbox, including updates.
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, path);
      // Make the replacement durable across power loss, not merely visible in
      // the OS page cache. Sync the directory entry after the atomic rename.
      if (process.platform !== 'win32') {
        const directoryHandle = await open(dirname(path), 'r');
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
    } catch (error) {
      // A failed write must not leave plaintext Telegram messages in a temp file.
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  function mutate(change) {
    const operation = writeChain.then(async () => {
      const current = await load();
      // Never mutate the cached snapshot before the durable replacement succeeds.
      // If disk persistence fails, later duplicate checks must not observe an
      // update that was never safely stored.
      const draft = structuredClone(current);
      const result = await change(draft);
      try {
        await persist(draft);
      } catch (error) {
        // Persistence can fail after rename (for example, directory sync). The
        // canonical path may then contain the draft even though it was not
        // confirmed durable. Drop the cache so the next operation reconciles
        // with disk instead of overwriting that possibly-visible replacement.
        statePromise = undefined;
        throw error;
      }
      statePromise = Promise.resolve(draft);
      return result;
    });
    writeChain = operation.catch(() => {});
    return operation;
  }

  function readConsistent(read) {
    const pendingWrites = writeChain;
    return pendingWrites.then(async () => read(await load()));
  }

  return Object.freeze({
    async enqueue({ botId, updateId, userId, update }) {
      const rawBotId = String(botId ?? '').trim();
      const rawUpdateId = String(updateId ?? '');
      const numericUpdateId = Number(rawUpdateId);
      const keyParts = [rawBotId, String(numericUpdateId)];
      if (!/^\d{1,16}$/.test(rawBotId) || !Number.isSafeInteger(Number(rawBotId))
        || Number(rawBotId) <= 0 || String(Number(rawBotId)) !== rawBotId
        || !/^\d+$/.test(rawUpdateId)
        || !Number.isSafeInteger(numericUpdateId) || numericUpdateId < 0
        || numericUpdateId >= Number.MAX_SAFE_INTEGER) {
        throw new TypeError('botId and a safe numeric Telegram updateId are required.');
      }
      if (!/^\d{1,16}$/.test(String(userId ?? '')) || !Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) {
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
          userId: String(Number(userId)),
          update: JSON.parse(serializedUpdate),
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
      return readConsistent(state => {
        const item = state.items.find(entry => entry.status === 'pending');
        return item ? structuredClone(item) : null;
      });
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
        if (!item || item.status !== 'processing') return false;
        item.status = 'pending';
        item.lastError = safeInboxError('pending');
        return true;
      });
    },

    async markCompleted(id, operationId) {
      const normalizedOperationId = typeof operationId === 'string'
        ? operationId.trim()
        : Number.isSafeInteger(operationId) && operationId >= 0
          ? String(operationId)
          : '';
      if (!normalizedOperationId || normalizedOperationId.length > 256) {
        throw new TypeError('A valid committed Buildbook operation ID is required to complete an inbox item.');
      }
      return mutate(state => {
        const item = state.items.find(entry => entry.id === id);
        if (!item) return false;
        if (item.status === 'completed') return item.operationId === normalizedOperationId;
        if (item.status !== 'processing') return false;
        item.status = 'completed';
        item.operationId = normalizedOperationId;
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
        if (!item || item.status !== 'processing') return false;
        item.status = 'rejected';
        item.lastError = safeInboxError('rejected');
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

    /**
     * Remove terminal inbox records only after the durable Telegram checkpoint
     * has advanced beyond them. The canonical finance idempotency ledger is
     * retained independently, so a replayed update still cannot create a
     * second financial effect. Pending/processing records are never compacted.
     */
    async compactAcknowledged(offset) {
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new TypeError('A durable non-negative Telegram checkpoint is required.');
      }
      const hasAcknowledgedTerminalItems = await readConsistent(state =>
        state.items.some(item =>
          ['completed', 'rejected'].includes(item.status) && item.updateId < offset
        )
      );
      if (!hasAcknowledgedTerminalItems) return 0;

      return mutate(state => {
        const before = state.items.length;
        state.items = state.items.filter(item =>
          !(['completed', 'rejected'].includes(item.status) && item.updateId < offset)
        );
        return before - state.items.length;
      });
    },

    async stats() {
      return readConsistent(state => {
        const result = { total: state.items.length, pending: 0, processing: 0, completed: 0, rejected: 0 };
        for (const item of state.items) {
          if (Object.hasOwn(result, item.status)) result[item.status] += 1;
        }
        return result;
      });
    }
  });
}
