import { randomUUID } from 'node:crypto';

const MAX_OPERATION_KEYS = 100_000;
const KEY_PATTERN = /^\d{1,16}:\d+$/;

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
    || !Number.isFinite(value.amount) || value.amount <= 0
    || typeof value.desc !== 'string' || !value.desc.trim() || value.desc.length > 500
    || typeof value.cat !== 'string' || value.cat.length > 200
    || typeof value.grp !== 'string' || value.grp.length > 200
    || !(value.qty === undefined || value.qty === null || Number.isFinite(value.qty))
    || !(value.acc === undefined || value.acc === null || typeof value.acc === 'string')
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
  if (profile.telegramOperations !== undefined
    && (!Array.isArray(profile.telegramOperations)
      || profile.telegramOperations.length > MAX_OPERATION_KEYS
      || profile.telegramOperations.some(entry => !isRecord(entry)
        || typeof entry.key !== 'string' || !KEY_PATTERN.test(entry.key)
        || typeof entry.operationId !== 'string' || !entry.operationId))) {
    const error = new Error('Canonical profile contains an invalid Telegram idempotency ledger.');
    error.code = 'INVALID_TELEGRAM_OPERATION_LEDGER';
    throw error;
  }
}

/**
 * Atomically commits Telegram-created finance transactions to the same profile
 * store used by the application. buildTransaction translates a validated
 * private Telegram update into the app's transaction shape.
 *
 * The operation ledger and transaction are written in one profile revision.
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
    if (typeof idempotencyKey !== 'string' || !KEY_PATTERN.test(idempotencyKey)) {
      const error = new TypeError('A canonical Telegram idempotency key is required.');
      error.code = 'INVALID_TELEGRAM_IDEMPOTENCY_KEY';
      throw error;
    }

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

    if (ledger.length >= MAX_OPERATION_KEYS) {
      const error = new RangeError('Telegram idempotency ledger reached its configured limit.');
      error.code = 'TELEGRAM_OPERATION_LEDGER_FULL';
      throw error;
    }

    const transaction = await buildTransaction(cloneJson(update));
    validateTransaction(transaction);
    const operationId = typeof transaction.id === 'string' && transaction.id.trim()
      ? transaction.id
      : randomUUID();
    const committedTransaction = { ...transaction, id: operationId };

    profile.state.tx.push(committedTransaction);
    profile.telegramOperations = [...ledger, { key: idempotencyKey, operationId }];
    const revision = await profileStore.write(profile, current.revision);
    return { operationId, revision, duplicate: false };
  };
}
