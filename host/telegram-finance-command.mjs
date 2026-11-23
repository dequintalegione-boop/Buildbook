const MAX_AMOUNT_CENTS = 100_000_000_000;
const COMMANDS = new Map([
  ['/доход', 'i'],
  ['/income', 'i'],
  ['/расход', 'e'],
  ['/expense', 'e'],
]);

function commandError(message, code = 'INVALID_TELEGRAM_FINANCE_COMMAND') {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function parseAmount(raw) {
  if (!/^(?:0|[1-9]\d{0,8})(?:[.,]\d{1,2})?$/.test(raw)) return null;
  const amount = Number(raw.replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || cents > MAX_AMOUNT_CENTS) return null;
  return cents / 100;
}

/** Parse explicit private-chat commands; unrelated text returns null. */
export function parseTelegramFinanceCommand(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = /^(\/[^\s@]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const kind = COMMANDS.get(match[1].toLowerCase());
  if (!kind) return null;
  const payload = String(match[2] || '').trim();
  const split = /^([^\s]+)\s+([\s\S]+)$/.exec(payload);
  if (!split) throw commandError('Формат: /доход 1250 Описание или /расход 450 Описание.');
  const amount = parseAmount(split[1]);
  if (amount === null) throw commandError('Сумма должна быть положительным числом, максимум 2 знака после запятой.');
  const desc = split[2].trim();
  if (!desc || desc.length > 300) throw commandError('Описание должно содержать от 1 до 300 символов.');
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

function resolveAccount(state) {
  const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
  const preferred = accounts.find(account => account && account.name === 'Наличные' && typeof account.id === 'string' && account.id.trim());
  const account = preferred || accounts.find(item => item && typeof item.id === 'string' && item.id.trim());
  if (account) return account.id;
  const error = commandError('В Buildbook не найден счёт для Telegram-операций.');
  error.code = 'TELEGRAM_FINANCE_ACCOUNT_UNAVAILABLE';
  throw error;
}

/** Convert a parsed command to Buildbook's transaction schema. */
export function buildTelegramFinanceTransaction(command, { now = new Date(), profile } = {}) {
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
  const accountId = state ? resolveAccount(state) : 'a1';
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  return {
    kind: command.kind,
    date,
    amount: command.amount,
    desc: command.desc.trim(),
    cat: category.cat,
    grp: category.grp,
    acc: accountId,
    note: 'Добавлено через Telegram',
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
