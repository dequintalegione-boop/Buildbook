const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

export function formatTelegramMoney(amount) {
  const negative = amount < 0;
  const cents = Math.round(Math.abs(amount) * 100);
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (negative ? '-' : '') + grouped + ',' + fraction + ' ₽';
}

export function telegramMonthKey(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('now must be a valid Date.');
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

/**
 * Month totals use the same income/expense rule as the Buildbook summary:
 * only kind "i" and "e" count. Loans, transfers and investments are excluded.
 * Deleted records are excluded. The profile itself is not modified.
 */
export function formatTelegramMonthSummary(profile, month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    throw new TypeError('Month statistics require a YYYY-MM key.');
  }
  const monthNumber = Number(month.slice(5, 7));
  const year = Number(month.slice(0, 4));
  if (monthNumber < 1 || monthNumber > 12) throw new TypeError('Month statistics require a real calendar month.');
  const transactions = profile?.state?.tx;
  if (!Array.isArray(transactions)) {
    const error = new Error('Canonical profile does not contain the Buildbook finance state.');
    error.code = 'BUILD_BOOK_FINANCE_STATE_UNAVAILABLE';
    throw error;
  }

  let incomeCents = 0;
  let expenseCents = 0;
  let count = 0;
  for (const item of transactions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (item.deletedAt) continue;
    if (typeof item.date !== 'string' || item.date.slice(0, 7) !== month) continue;
    if (item.kind !== 'i' && item.kind !== 'e') continue;
    const amount = Number(item.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const cents = Math.round(amount * 100);
    if (!Number.isSafeInteger(cents) || cents <= 0) continue;
    if (item.kind === 'i') incomeCents += cents;
    else expenseCents += cents;
    count += 1;
  }

  const income = incomeCents / 100;
  const expense = expenseCents / 100;
  const net = (incomeCents - expenseCents) / 100;
  const title = MONTHS[monthNumber - 1] + ' ' + year;
  return [
    title.charAt(0).toUpperCase() + title.slice(1),
    'Доходы: ' + formatTelegramMoney(income),
    'Расходы: ' + formatTelegramMoney(expense),
    'Итог: ' + formatTelegramMoney(net),
    'Операций: ' + count,
  ].join('\n');
}
