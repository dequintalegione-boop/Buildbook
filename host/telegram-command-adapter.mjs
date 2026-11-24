import { createProfileFinanceAdapter } from './profile-finance-adapter.mjs';
import {
  TELEGRAM_HELP_TEXT,
  buildTelegramFinanceTransactionFromUpdate,
  classifyTelegramCommand,
  parseTelegramFinanceCommand,
} from './telegram-finance-command.mjs';
import { formatTelegramMoney, formatTelegramMonthSummary, telegramMonthKey } from './telegram-month-stats.mjs';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Routes an allowlisted private command to either a canonical finance write
 * or a read-only reply. Read-only commands do not change the profile.
 * The returned reply is sent only after this function resolves, and only to
 * the user already accepted by the allowlist gate.
 */
export function createTelegramCommandAdapter({
  profileStore,
  buildTransaction,
  now = () => new Date(),
} = {}) {
  if (!profileStore || typeof profileStore.read !== 'function' || typeof profileStore.write !== 'function') {
    throw new TypeError('A canonical profile store with read/write methods is required.');
  }
  if (typeof now !== 'function') throw new TypeError('A command clock function is required.');
  const applyFinance = createProfileFinanceAdapter({
    profileStore,
    buildTransaction: buildTransaction || buildTelegramFinanceTransactionFromUpdate,
  });

  return async function applyTelegramCommand({ update, idempotencyKey } = {}) {
    let command;
    try {
      command = classifyTelegramCommand(update?.message?.text);
    } catch (error) {
      error.permanent = true;
      if (typeof error.reply !== 'string' || !error.reply.trim()) error.reply = TELEGRAM_HELP_TEXT;
      throw error;
    }
    if (!command) {
      const error = new TypeError('Telegram message is not a command.');
      error.code = 'IGNORED_TELEGRAM_TEXT';
      error.permanent = true;
      throw error;
    }
    if (command.type === 'help') {
      return { operationId: 'help:' + idempotencyKey, reply: TELEGRAM_HELP_TEXT };
    }
    if (command.type === 'stats') {
      const current = await profileStore.read();
      if (!current || !isRecord(current.profile)) {
        const error = new Error('Canonical Buildbook profile is not initialized.');
        error.code = 'BUILD_BOOK_PROFILE_UNAVAILABLE';
        throw error;
      }
      const when = now();
      const reply = formatTelegramMonthSummary(current.profile, command.month || telegramMonthKey(when));
      return { operationId: 'stats:' + idempotencyKey, reply };
    }

    let parsed;
    try {
      parsed = parseTelegramFinanceCommand(update?.message?.text);
    } catch (error) {
      error.permanent = true;
      if (typeof error.reply !== 'string' || !error.reply.trim()) error.reply = TELEGRAM_HELP_TEXT;
      throw error;
    }
    if (!parsed) {
      const error = new TypeError('Telegram finance command could not be parsed.');
      error.code = 'INVALID_TELEGRAM_FINANCE_COMMAND';
      error.permanent = true;
      error.reply = TELEGRAM_HELP_TEXT;
      throw error;
    }
    const result = await applyFinance({ update, idempotencyKey });
    const label = parsed.kind === 'i' ? 'Доход' : 'Расход';
    const reply = result?.duplicate
      ? 'Эта операция уже записана в Buildbook.'
      : label + ' ' + formatTelegramMoney(parsed.amount) + ' записан: ' + parsed.desc;
    return { ...result, reply };
  };
}
