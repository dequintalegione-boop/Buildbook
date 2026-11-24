const MAX_AMOUNT_CENTS = 100_000_000_000;
const COMMANDS = new Map([
  ['/доход', 'i'],
  ['/income', 'i'],
  ['/расход', 'e'],
  ['/expense', 'e'],
]);
const STATS_COMMANDS = new Set(['/статистика', '/stats', '/месяц']);
const HELP_COMMANDS = new Set(['/help', '/start', '/справка', '/старт']);

export const TELEGRAM_HELP_TEXT = [
  'Команды Buildbook:',
  '/доход 1250 Описание',
  '/расход 450 Описание',
  '/статистика — доходы и расходы за текущий месяц',
  '/статистика 2026-11 — за выбранный месяц',
  '/help — эта справка',
].join('\n');

function commandError(message, code = 'INVALID_TELEGRAM_FINANCE_COMMAND') {
  const error = new TypeError(message);
  error.code = code;
  error.reply = message;
  return error;
}

function splitCommand(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = /^\/([^\s@]{1,64})(?:@[A-Za-z0-9_]{1,64})?(?:\s+([\s\S]*))?$/u.exec(trimmed);
  if (!match) return null;
  return { name: '/' + match[1].toLowerCase(), rest: String(match[2] || '').trim() };
}

function parseAmount(raw) {
  if (!/^(?:0|[1-9]\d{0,8})(?:[.,]\d{1,2})?$/.test(raw)) return null;
  const amount = Number(raw.replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || cents > MAX_AMOUNT_CENTS) return null;
  return cents / 100;
}

/**
 * Classify a private message. Non-commands return null and must be ignored
 * without a reply. Unknown slash commands and bad finance syntax throw a
 * permanent error whose reply is safe to send to the allowlisted user.
 */
export function classifyTelegramCommand(text) {
  const split = splitCommand(text);
  if (!split) return null;
  if (HELP_COMMANDS.has(split.name)) return Object.freeze({ type: 'help' });
  if (STATS_COMMANDS.has(split.name)) {
    if (!split.rest) return Object.freeze({ type: 'stats', month: null });
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(split.rest)) {
      throw commandError('Месяц указывайте как ГГГГ-ММ, например /статистика 2026-11.');
    }
    const year = Number(split.rest.slice(0, 4));
    if (year < 2000 || year > 2100) throw commandError('Месяц указывайте как ГГГГ-ММ, например /статистика 2026-11.');
    return Object.freeze({ type: 'stats', month: split.rest });
  }
  if (COMMANDS.has(split.name)) return Object.freeze({ type: 'finance' });
  throw commandError('Неизвестная команда. Отправьте /help, чтобы увидеть список.');
}

/** Parse explicit private-chat commands; unrelated text returns null. */
export function parseTelegramFinanceCommand(text) {
  const split = splitCommand(text);
  if (!split) return null;
  const kind = COMMANDS.get(split.name);
  if (!kind) return null;
  const payload = split.rest;
  const parts = /^([^\s]+)\s+([\s\S]+)$/.exec(payload);
  if (!parts) throw commandError('Формат: /доход 1250 Описание или /расход 450 Описание.');
  const amount = parseAmount(parts[1]);
  if (amount === null) throw commandError('Сумма должна быть положительным числом, максимум 2 знака после запятой.');
  const desc = parts[2].trim();
  if (!desc || desc.length > 300) throw commandError('Описание должно содержать от 1 до 300 символов.');
  if (/[\u0000-\u001f\u007f]/u.test(desc)) {
    throw commandError('Описание не должно содержать управляющие символы или переносы строк.');
  }
  return Object.freeze({ kind, amount, desc });
}

function resolveCategory(state, kind) {
  const groups = state?.categories?.[kind];
  const hiddenGroups = new Set(Array.isArray(state?.hiddenGroups?.[kind]) ? state.hiddenGroups[kind] : []);
  const hiddenCategories = new Set(Array.isArray(state?.hiddenCategories?.[kind]) ? state.hiddenCategories[kind] : []);
  const preferredGroup = kind === 'i' ? 'Заработок' : 'Общие расходы';
  const preferredCategory = kind === 'i' ? 'Другое' : 'Еда';
  const entries = groups && typeof groups === 'object' && !Array.isArray(groups)
    ? Object.entries(groups)
    : [];
  const available = entries
    .filter(([group, items]) => typeof group === 'string' && !hiddenGroups.has(group) && Array.isArray(items))
    .map(([group, items]) => ({
      group,
      categories: items.filter(category => typeof category === 'string'
        && category.trim()
        && !hiddenCategories.has(group + '::' + category)),
    }))
    .filter(entry => entry.categories.length);
  if (!available.length) {
    const error = commandError('В Buildbook нет доступной категории для этой операции.');
    error.code = 'TELEGRAM_FINANCE_CATEGORY_UNAVAILABLE';
    throw error;
  }
  const selectedGroup = available.find(entry => entry.group === preferredGroup) || available[0];
  const category = selectedGroup.categories.includes(preferredCategory)
    ? preferredCategory
    : selectedGroup.categories[0];
  return { grp: selectedGroup.group, cat: category };
}

function resolveAccount(state, preferredId = null) {
  const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
  const validAccounts = accounts.filter(account =>
    account && typeof account.id === 'string' && account.id.trim()
  );
  const requireUniqueId = account => {
    const matches = validAccounts.filter(candidate => candidate.id === account.id);
    if (matches.length !== 1) {
      const error = commandError('В профиле Buildbook повторяется ID выбранного счёта. Исправьте список счетов перед записью через Telegram.');
      error.code = 'TELEGRAM_FINANCE_ACCOUNT_AMBIGUOUS';
      throw error;
    }
    return account.id;
  };

  if (preferredId) {
    const matches = validAccounts.filter(account => account.id === preferredId);
    if (matches.length === 1) return requireUniqueId(matches[0]);
    const error = commandError(matches.length > 1
      ? 'Выбранный счёт Telegram неоднозначен: в профиле Buildbook повторяется его ID.'
      : 'Выбранный счёт Telegram не найден в текущем профиле Buildbook. Проверьте BUILDBOOK_TELEGRAM_DEFAULT_ACCOUNT_ID.');
    error.code = 'TELEGRAM_FINANCE_ACCOUNT_UNAVAILABLE';
    throw error;
  }

  const cashAccounts = validAccounts.filter(account => account.name === 'Наличные');
  if (cashAccounts.length > 1) {
    const error = commandError('В Buildbook несколько счетов «Наличные». Укажите BUILDBOOK_TELEGRAM_DEFAULT_ACCOUNT_ID, чтобы выбрать счёт однозначно.');
    error.code = 'TELEGRAM_FINANCE_ACCOUNT_AMBIGUOUS';
    throw error;
  }
  if (cashAccounts.length === 1) return requireUniqueId(cashAccounts[0]);
  if (validAccounts.length) return requireUniqueId(validAccounts[0]);

  const error = commandError('В Buildbook не найден счёт для Telegram-операций.');
  error.code = 'TELEGRAM_FINANCE_ACCOUNT_UNAVAILABLE';
  throw error;
}

/** Convert a parsed command to Buildbook's transaction schema. */
export function buildTelegramFinanceTransaction(command, { now = new Date(), profile, defaults } = {}) {
  if (!command || !['i', 'e'].includes(command.kind)
    || !Number.isFinite(command.amount) || command.amount <= 0
    || typeof command.desc !== 'string' || !command.desc.trim()) {
    throw commandError('Некорректная финансовая команда.');
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('now must be a valid Date.');
  const state = profile?.state;
  const category = state ? resolveCategory(state, command.kind) : {
    grp: command.kind === 'i' ? 'Заработок' : 'Общие расходы',
    cat: command.kind === 'i' ? 'Другое' : 'Еда',
  };
  const accountId = state ? resolveAccount(state, defaults?.accountId || null) : 'a1';
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  const iso = now.toISOString();
  return {
    kind: command.kind,
    date,
    amount: command.amount,
    desc: command.desc.trim(),
    cat: category.cat,
    grp: category.grp,
    acc: accountId,
    note: 'Добавлено через Telegram',
    createdAt: iso,
    updatedAt: iso,
    deletedAt: null,
    schemaVersion: 5,
  };
}
/** Build the finance transaction directly from the sanitized Telegram envelope. */
export function buildTelegramFinanceTransactionFromUpdate(update, options) {
  const command = parseTelegramFinanceCommand(update?.message?.text);
  if (!command) {
    const error = commandError('Сообщение не является поддерживаемой финансовой командой.');
    error.permanent = true;
    throw error;
  }
  try {
    return buildTelegramFinanceTransaction(command, options);
  } catch (error) {
    error.permanent = true;
    throw error;
  }
}
