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

/** Convert a parsed command to Buildbook's transaction schema. */
export function buildTelegramFinanceTransaction(command, { now = new Date() } = {}) {
  if (!command || !['i', 'e'].includes(command.kind)
    || !Number.isFinite(command.amount) || command.amount <= 0
    || typeof command.desc !== 'string' || !command.desc.trim()) {
    throw commandError('Некорректная финансовая команда.');
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('now must be a valid Date.');
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  return {
    kind: command.kind,
    date,
    amount: command.amount,
    desc: command.desc.trim(),
    cat: 'Прочее',
    grp: 'Прочее',
    acc: 'Наличные',
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
