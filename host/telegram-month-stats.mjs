const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

export function formatTelegramMoney(amount) {
  if (!Number.isFinite(amount) || !Number.isSafeInteger(Math.round(Math.abs(amount) * 100))) {
    throw new TypeError('Money amount must be finite and representable in safe integer cents.');
  }
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
  if (monthNumber < 1 || monthNumber > 12 || year < 2000 || year > 2100) {
    throw new TypeError('Month statistics require a real calendar month between 2000 and 2100.');
  }
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
    if (typeof item.date !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(item.date)
      || item.date.slice(0, 7) !== month) continue;
    const day = Number(item.date.slice(8, 10));
    const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    if (day < 1 || day > daysInMonth) continue;
    if (item.kind !== 'i' && item.kind !== 'e') continue;
    if (typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount <= 0) continue;
    const amount = item.amount;
    const cents = Math.round(amount * 100);
    if (!Number.isSafeInteger(cents) || cents <= 0) continue;
    if (item.kind === 'i') {
      if (!Number.isSafeInteger(incomeCents + cents)) throw new RangeError('Monthly income exceeds safe integer cents.');
      incomeCents += cents;
    } else {
      if (!Number.isSafeInteger(expenseCents + cents)) throw new RangeError('Monthly expenses exceed safe integer cents.');
      expenseCents += cents;
    }
    count += 1;
  }

  const netCents = incomeCents - expenseCents;
  if (!Number.isSafeInteger(netCents)) throw new RangeError('Monthly net total exceeds safe integer cents.');
  const income = incomeCents / 100;
  const expense = expenseCents / 100;
  const net = netCents / 100;
  const title = MONTHS[monthNumber - 1] + ' ' + year;
  return [
    title.charAt(0).toUpperCase() + title.slice(1),
    'Доходы: ' + formatTelegramMoney(income),
    'Расходы: ' + formatTelegramMoney(expense),
    'Итог: ' + formatTelegramMoney(net),
    'Операций: ' + count,
  ].join('\n');
}
