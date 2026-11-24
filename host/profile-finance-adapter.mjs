import { randomUUID } from 'node:crypto';

const MAX_LEGACY_OPERATION_KEYS = 100_000;
const MAX_OPERATION_CHECKPOINT_BOTS = 1000;
function isValidIdempotencyKey(value) {
  if (typeof value !== 'string') return false;
  const match = /^([1-9]\d{0,15}):(0|[1-9]\d*)$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return false;
  const updateId = Number(match[2]);
  return Number.isSafeInteger(updateId)
    && updateId >= 0
    && updateId < Number.MAX_SAFE_INTEGER
    && String(updateId) === match[2];
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateTransaction(value) {
  if (!isRecord(value)
    || !['i', 'e'].includes(value.kind)
    || typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)
    || !Number.isFinite(Date.parse(value.date + 'T00:00:00Z'))
    || new Date(value.date + 'T00:00:00Z').toISOString().slice(0, 10) !== value.date
    || !Number.isFinite(value.amount) || value.amount <= 0 || value.amount > 1_000_000_000
    || Math.abs(value.amount * 100 - Math.round(value.amount * 100)) > 1e-8
    || typeof value.desc !== 'string' || !value.desc.trim() || value.desc.length > 500
    || typeof value.cat !== 'string' || !value.cat.trim() || value.cat.length > 200
    || typeof value.grp !== 'string' || !value.grp.trim() || value.grp.length > 200
    || !(value.qty === undefined || value.qty === null || Number.isFinite(value.qty))
    || typeof value.acc !== 'string' || !value.acc.trim() || value.acc.length > 200
    || !(value.note === undefined || value.note === null || typeof value.note === 'string' && value.note.length <= 2000)) {
    const error = new TypeError('Telegram adapter produced an invalid Buildbook transaction.');
    error.code = 'INVALID_BUILD_BOOK_TRANSACTION';
    throw error;
  }
}

function validateProfile(profile) {
  if (!isRecord(profile) || !isRecord(profile.state) || !Array.isArray(profile.state.tx)) {
    const error = new Error('Canonical profile does not contain the Buildbook finance state.');
    error.code = 'BUILD_BOOK_FINANCE_STATE_UNAVAILABLE';
    throw error;
  }

  if (profile.telegramOperationCheckpoints !== undefined) {
    const checkpoints = profile.telegramOperationCheckpoints;
    const bots = new Set();
    if (!Array.isArray(checkpoints) || checkpoints.length > MAX_OPERATION_CHECKPOINT_BOTS) {
      const error = new Error('Canonical profile contains invalid Telegram operation checkpoints.');
      error.code = 'INVALID_TELEGRAM_OPERATION_LEDGER';
      throw error;
    }
    for (const checkpoint of checkpoints) {
      if (!isRecord(checkpoint)
        || typeof checkpoint.botId !== 'string'
        || !/^[1-9]\d{0,15}$/.test(checkpoint.botId)
        || !Number.isSafeInteger(Number(checkpoint.botId))
        || String(Number(checkpoint.botId)) !== checkpoint.botId
        || !Number.isSafeInteger(checkpoint.updateId)
        || checkpoint.updateId < 0
        || checkpoint.updateId >= Number.MAX_SAFE_INTEGER
        || bots.has(checkpoint.botId)) {
        const error = new Error('Canonical profile contains invalid Telegram operation checkpoints.');
        error.code = 'INVALID_TELEGRAM_OPERATION_LEDGER';
        throw error;
      }
      bots.add(checkpoint.botId);
    }
  }

  if (profile.telegramOperations !== undefined) {
    const ledger = profile.telegramOperations;
    const keys = new Set();
    const operationIds = new Set();
    if (!Array.isArray(ledger) || ledger.length > MAX_LEGACY_OPERATION_KEYS) {
      const error = new Error('Canonical profile contains an invalid Telegram idempotency ledger.');
      error.code = 'INVALID_TELEGRAM_OPERATION_LEDGER';
      throw error;
    }
    for (const entry of ledger) {
      if (!isRecord(entry) || !isValidIdempotencyKey(entry.key)
        || typeof entry.operationId !== 'string' || !entry.operationId.trim()
        || entry.operationId.length > 256 || entry.operationId !== entry.operationId.trim()
        || keys.has(entry.key) || operationIds.has(entry.operationId)) {
        const error = new Error('Canonical profile contains an invalid Telegram idempotency ledger.');
        error.code = 'INVALID_TELEGRAM_OPERATION_LEDGER';
        throw error;
      }
      keys.add(entry.key);
      operationIds.add(entry.operationId);
    }
  }
}

/**
 * Compute a monotonic replay boundary per bot. Legacy ledger keys prove that
 * the corresponding finance updates committed; serial inbox processing means
 * no earlier finance update can still be waiting behind a later committed one.
 */
function getOperationCheckpoints(profile, ledger) {
  const checkpoints = new Map(
    (profile.telegramOperationCheckpoints || []).map(item => [item.botId, item.updateId])
  );
  for (const entry of ledger) {
    const [botId, rawUpdateId] = entry.key.split(':');
    const updateId = Number(rawUpdateId);
    checkpoints.set(botId, Math.max(checkpoints.get(botId) ?? -1, updateId));
  }
  if (checkpoints.size > MAX_OPERATION_CHECKPOINT_BOTS) {
    const error = new RangeError('Telegram replay checkpoint capacity reached.');
    error.code = 'TELEGRAM_OPERATION_CHECKPOINTS_FULL';
    throw error;
  }
  return checkpoints;
}

/**
 * Atomically commits Telegram-created finance transactions to the same profile
 * store used by the application. buildTransaction translates a validated
 * private Telegram update into the app's transaction shape.
 *
 * The transaction and per-bot replay checkpoint are written in one profile
 * revision. Legacy exact-key ledger entries remain readable for migration safety.
 * A caller must not mark the inbox item complete until this function returns.
 */
export function createProfileFinanceAdapter({ profileStore, buildTransaction } = {}) {
  if (!profileStore || typeof profileStore.read !== 'function' || typeof profileStore.write !== 'function') {
    throw new TypeError('A canonical profile store with read/write methods is required.');
  }
  if (typeof buildTransaction !== 'function') {
    throw new TypeError('A validated Telegram transaction builder is required.');
  }

  return async function applyUpdate({ update, idempotencyKey } = {}) {
    if (!isValidIdempotencyKey(idempotencyKey)) {
      const error = new TypeError('A canonical Telegram idempotency key is required.');
      error.code = 'INVALID_TELEGRAM_IDEMPOTENCY_KEY';
      throw error;
    }

    // Revision conflicts are safe to retry: the store uses compare-and-swap,
    // and the idempotency key is checked again after every fresh read.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await profileStore.read();
      if (!current || !Number.isSafeInteger(current.revision) || current.revision < 0 || !isRecord(current.profile)) {
        const error = new Error('Canonical Buildbook profile is not initialized.');
        error.code = 'BUILD_BOOK_PROFILE_UNAVAILABLE';
        throw error;
      }

      const profile = cloneJson(current.profile);
      validateProfile(profile);
      const ledger = profile.telegramOperations || [];
      const prior = ledger.find(entry => entry.key === idempotencyKey);
      if (prior) return { operationId: prior.operationId, duplicate: true };

      const [botId, rawUpdateId] = idempotencyKey.split(':');
      const updateId = Number(rawUpdateId);
      const checkpoints = getOperationCheckpoints(profile, ledger);
      if (!checkpoints.has(botId) && checkpoints.size >= MAX_OPERATION_CHECKPOINT_BOTS) {
        const error = new RangeError('Telegram replay checkpoint capacity reached.');
        error.code = 'TELEGRAM_OPERATION_CHECKPOINTS_FULL';
        throw error;
      }
      const checkpoint = checkpoints.get(botId) ?? -1;
      if (updateId <= checkpoint) {
        // A replay older than the committed boundary has no need to recreate
        // its original operation ID; the inbox only needs a stable completion ID.
        return { operationId: `telegram-replay:${idempotencyKey}`, duplicate: true };
      }

      // Builders must be pure: on a revision conflict they may be called again
      // with a refreshed profile so category/account changes are respected.
      const transaction = await buildTransaction(cloneJson(update), {
        profile: cloneJson(profile),
        idempotencyKey,
      });
      validateTransaction(transaction);
      const operationId = typeof transaction.id === 'string' && transaction.id.trim()
        ? transaction.id
        : randomUUID();
      if (profile.state.tx.some(item => item && item.id === operationId)) {
        const error = new Error('Buildbook transaction ID already exists.');
        error.code = 'DUPLICATE_BUILD_BOOK_OPERATION_ID';
        throw error;
      }
      const committedTransaction = { ...transaction, id: operationId };
      profile.state.tx.push(committedTransaction);

      // Advance the replay boundary in the same profile revision as the
      // transaction. New operations no longer append to the legacy key ledger.
      checkpoints.set(botId, updateId);
      profile.telegramOperationCheckpoints = [...checkpoints.entries()]
        .map(([checkpointBotId, checkpointUpdateId]) => ({
          botId: checkpointBotId,
          updateId: checkpointUpdateId,
        }));
      try {
        const revision = await profileStore.write(profile, current.revision);
        return { operationId, revision, duplicate: false };
      } catch (error) {
        if (error?.code !== 'BUILD_BOOK_STORAGE_CONFLICT' || attempt === 2) throw error;
      }
    }
    throw new Error('Canonical profile changed repeatedly; retry the Telegram operation later.');
  };
}
