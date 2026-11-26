import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { classifyTelegramCommand, parseTelegramFinanceCommand, TELEGRAM_HELP_TEXT } from '../host/telegram-finance-command.mjs';
import { createTelegramCommandAdapter } from '../host/telegram-command-adapter.mjs';
import { createTelegramReplySender } from '../host/telegram-reply.mjs';
import { createTelegramInboxProcessor } from '../host/telegram-inbox-processor.mjs';
import { formatTelegramMoney, formatTelegramMonthSummary } from '../host/telegram-month-stats.mjs';

function makeStore(profile) {
  let revision = 1;
  let current = structuredClone(profile);
  return {
    async read() { return { revision, profile: structuredClone(current) }; },
    async write(next, expectedRevision) {
      if (expectedRevision !== revision) {
        const error = new Error('revision conflict');
        error.code = 'BUILD_BOOK_STORAGE_CONFLICT';
        throw error;
      }
      current = structuredClone(next);
      revision += 1;
      return revision;
    },
    snapshot() { return { revision, profile: structuredClone(current) }; },
  };
}

function jsonResponse(body, status = 200) {
  const bytes = Buffer.from(JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => String(bytes.byteLength) },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

const profile = {
  state: {
    tx: [
      { id: '1', kind: 'i', date: '2026-11-02', amount: 1000, desc: 'Сборка' },
      { id: '2', kind: 'e', date: '2026-11-03', amount: 250.5, desc: 'Еда' },
      { id: '3', kind: 'i', date: '2026-10-30', amount: 9999, desc: 'Другой месяц' },
      { id: '4', kind: 'loan_in', date: '2026-11-04', amount: 500, desc: 'Долг' },
      { id: '5', kind: 'e', date: '2026-11-05', amount: 10, desc: 'Удалено', deletedAt: '2026-11-06T00:00:00.000Z' },
    ],
    accounts: [{ id: 'cash', name: 'Наличные' }],
    categories: {
      i: { 'Заработок': ['Другое'] },
      e: { 'Общие расходы': ['Еда'] },
    },
  },
};

test('finance amount parser accepts the configured maximum and rejects amounts above it', () => {
  assert.equal(parseTelegramFinanceCommand('/доход 1000000000 Максимум').amount, 1_000_000_000);
  assert.throws(() => parseTelegramFinanceCommand('/доход 1000000000,01 Слишком много'), /положительным числом/);
});

test('classifier accepts help, stats and finance, and stays quiet for plain text', () => {
  assert.deepEqual(classifyTelegramCommand('/help'), { type: 'help' });
  assert.deepEqual(classifyTelegramCommand('/статистика'), { type: 'stats', month: null });
  assert.deepEqual(classifyTelegramCommand('/stats 2026-11'), { type: 'stats', month: '2026-11' });
  assert.deepEqual(classifyTelegramCommand('/доход 10 Текст'), { type: 'finance' });
  assert.equal(classifyTelegramCommand('привет'), null);
  assert.equal(classifyTelegramCommand('/доход@anotherbot 10 Текст'), null);
  assert.equal(parseTelegramFinanceCommand('/расход@anotherbot 10 Текст'), null);
  assert.throws(() => classifyTelegramCommand('/статистика ноябрь'), /ГГГГ-ММ/);
  assert.throws(() => classifyTelegramCommand('/unknown'), /Неизвестная команда/);
});

test('finance command commits once and returns a confirmation reply', async () => {
  const store = makeStore(profile);
  const apply = createTelegramCommandAdapter({
    profileStore: store,
    now: () => new Date(2026, 10, 24, 9, 0, 0),
    getCommandSettings: async () => ({ income: true, expense: true, stats: true, help: true }),
  });
  const update = { update_id: 8, message: { text: '/расход 40 Обед' } };
  const first = await apply({ update, idempotencyKey: '123456:8' });
  const duplicate = await apply({ update, idempotencyKey: '123456:8' });
  assert.equal(first.duplicate, false);
  assert.match(first.reply, /Расход 40,00 ₽ записан: Обед/);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.reply, 'Эта операция уже записана в Buildbook.');
  assert.equal(duplicate.operationId, 'telegram-replay:123456:8');
  assert.equal(store.snapshot().profile.state.tx.length, profile.state.tx.length + 1);
});

test('month statistics read the canonical profile and do not write it', async () => {
  const store = makeStore(profile);
  const apply = createTelegramCommandAdapter({
    profileStore: store,
    now: () => new Date(2026, 10, 24, 9, 0, 0),
    getCommandSettings: async () => ({ income: true, expense: true, stats: true, help: true }),
  });
  const current = await apply({ update: { update_id: 9, message: { text: '/статистика' } }, idempotencyKey: '123456:9' });
  const selected = await apply({ update: { update_id: 10, message: { text: '/месяц 2026-10' } }, idempotencyKey: '123456:10' });
  assert.equal(current.operationId, 'stats:123456:9');
  assert.match(current.reply, /Ноябрь 2026/);
  assert.match(current.reply, /Доходы: 1 000,00 ₽/);
  assert.match(current.reply, /Расходы: 250,50 ₽/);
  assert.match(current.reply, /Итог: 749,50 ₽/);
  assert.match(current.reply, /Операций: 2/);
  assert.match(selected.reply, /Октябрь 2026/);
  assert.match(selected.reply, /Доходы: 9 999,00 ₽/);
  assert.match(selected.reply, /Операций: 1/);
  assert.equal(store.snapshot().revision, 1);
  assert.equal(store.snapshot().profile.telegramOperations, undefined);
});

test('help does not write, plain text has no reply, and bad syntax does', async () => {
  const store = makeStore(profile);
  const apply = createTelegramCommandAdapter({ profileStore: store, now: () => new Date(2026, 10, 24), getCommandSettings: async () => ({ income: true, expense: true, stats: true, help: true }) });
  const help = await apply({ update: { update_id: 11, message: { text: '/start' } }, idempotencyKey: '123456:11' });
  assert.equal(help.reply, TELEGRAM_HELP_TEXT);
  assert.match(help.reply, /\/месяц 2026-11/);
  await assert.rejects(
    apply({ update: { update_id: 12, message: { text: 'просто текст' } }, idempotencyKey: '123456:12' }),
    error => error.permanent === true && error.reply === '',
  );
  await assert.rejects(
    apply({ update: { update_id: 13, message: { text: '/доход' } }, idempotencyKey: '123456:13' }),
    error => error.permanent === true && /Формат/.test(error.reply),
  );
  assert.equal(store.snapshot().revision, 1);
});

test('reply sender posts only the chat and text and hides the bot token from errors', async () => {
  let seen;
  const send = createTelegramReplySender({
    botToken: '123456:super-secret-token',
    async fetchImpl(url, options) {
      seen = { href: String(url), options };
      return jsonResponse({ ok: true, result: { message_id: 7 } });
    },
  });
  await send({ chatId: '1001', text: 'Доход записан', replyToMessageId: 4 });
  assert.match(seen.href, /\/sendMessage$/);
  assert.equal(seen.href.includes('super-secret-token'), true);
  const body = JSON.parse(seen.options.body);
  assert.deepEqual(body, {
    chat_id: 1001,
    text: 'Доход записан',
    disable_web_page_preview: true,
    reply_to_message_id: 4,
  });
  assert.equal(JSON.stringify(body).includes('super-secret-token'), false);

  const failing = createTelegramReplySender({
    botToken: '123456:super-secret-token',
    async fetchImpl() { throw new Error('connect failed https://api.telegram.org/bot123456:super-secret-token/sendMessage'); },
  });
  await assert.rejects(failing({ chatId: '1001', text: 'нет' }), error => {
    assert.equal(error.code, 'TELEGRAM_REPLY_FAILED');
    assert.equal(String(error.message).includes('super-secret-token'), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('processor delivers the reply before completion and retries when delivery fails', async () => {
  const item = {
    id: 'inbox-1',
    botId: '123456',
    updateId: 44,
    key: '123456:44',
    userId: '1001',
    update: { update_id: 44, message: { message_id: 44, from: { id: 1001 }, chat: { id: 1001, type: 'private' }, text: '/stats' } },
  };
  const state = { status: 'pending', calls: [] };
  const inbox = {
    async nextPending() { return state.status === 'pending' ? structuredClone(item) : null; },
    async markProcessing() { state.status = 'processing'; state.calls.push('processing'); return true; },
    async markPending(_id, message) { state.status = 'pending'; state.error = message; state.calls.push('pending'); return true; },
    async markCompleted(_id, operationId) { state.status = 'completed'; state.operationId = operationId; state.calls.push('completed'); return true; },
    async markRejected() { state.status = 'rejected'; state.calls.push('rejected'); return true; },
    async markReplyDelivered() { state.replyDeliveredAt = new Date().toISOString(); state.calls.push('reply-delivered'); return true; },
  };
  let deliveries = 0;
  const processor = createTelegramInboxProcessor({
    inbox,
    async applyUpdate() { return { operationId: 'stats:123456:44', reply: 'Ноябрь 2026' }; },
    async deliverReply(reply) {
      deliveries += 1;
      state.calls.push('reply:' + reply.chatId);
      if (deliveries === 1) throw new Error('token=super-secret-token');
    },
  });
  await assert.rejects(processor.processOne(), /super-secret-token/);
  assert.equal(state.status, 'pending');
  assert.equal(state.error.includes('super-secret-token'), false);
  const done = await processor.processOne();
  assert.equal(done.processed, true);
  assert.deepEqual(state.calls, ['processing', 'reply:1001', 'pending', 'processing', 'reply:1001', 'reply-delivered', 'completed']);
  assert.equal(state.operationId, 'stats:123456:44');
});

test('ordinary text is rejected silently without a help reply', async () => {
  const store = makeStore(profile);
  const apply = createTelegramCommandAdapter({ profileStore: store });
  await assert.rejects(
    apply({ update: { update_id: 14, message: { text: 'привет' } }, idempotencyKey: '123456:14' }),
    error => {
      assert.equal(error.code, 'IGNORED_TELEGRAM_TEXT');
      assert.equal(error.permanent, true);
      assert.equal(error.reply, '');
      return true;
    },
  );
  assert.equal(store.snapshot().profile.state.tx.length, profile.state.tx.length);
});


test('monthly stats reject invalid dates, unsafe totals and nonnumeric amounts', () => {
  assert.throws(() => formatTelegramMoney(Number.POSITIVE_INFINITY), /finite/);
  assert.throws(() => formatTelegramMonthSummary(profile, '1999-11'), /2000 and 2100/);
  const invalidDates = { state: { tx: [
    { kind: 'i', date: '2026-11-31', amount: 100 },
    { kind: 'i', date: '2026-11-02-extra', amount: 200 },
    { kind: 'i', date: '2026-11-03', amount: '300' },
    { kind: 'i', date: '2026-11-30', amount: 50 },
  ] } };
  assert.match(formatTelegramMonthSummary(invalidDates, '2026-11'), /Доходы: 50,00 ₽/);
  assert.match(formatTelegramMonthSummary({ state: { tx: [
    { kind: 'i', date: '2024-02-29', amount: 1 },
  ] } }, '2024-02'), /Доходы: 1,00 ₽/);
  const tooLarge = { state: { tx: [
    { kind: 'i', date: '2026-11-01', amount: Number.MAX_SAFE_INTEGER / 100 },
    { kind: 'i', date: '2026-11-02', amount: 1 },
  ] } };
  assert.throws(() => formatTelegramMonthSummary(tooLarge, '2026-11'), /safe integer cents/);
});

test('finance and stats commands are disabled by default and can be enabled independently', async () => {
  const store = makeStore(profile);
  const settings = { income: false, expense: false, stats: false, help: true };
  const apply = createTelegramCommandAdapter({
    profileStore: store,
    getCommandSettings: async () => ({ ...settings }),
  });
  const expenseUpdate = { update_id: 50, message: { text: '/расход 40 Обед' } };
  const disabledExpense = await apply({ update: expenseUpdate, idempotencyKey: '123456:50' });
  assert.match(disabledExpense.reply, /Добавление расходов отключено/);
  assert.equal(store.snapshot().profile.state.tx.length, profile.state.tx.length);

  settings.expense = true;
  const enabledExpense = await apply({ update: { update_id: 51, message: { text: '/расход 40 Обед' } }, idempotencyKey: '123456:51' });
  assert.match(enabledExpense.reply, /Расход 40,00 ₽ записан/);
  assert.equal(store.snapshot().profile.state.tx.length, profile.state.tx.length + 1);

  const statsUpdate = { update_id: 52, message: { text: '/stats' } };
  const disabledStats = await apply({ update: statsUpdate, idempotencyKey: '123456:52' });
  assert.match(disabledStats.reply, /статистики отключена/);
  settings.stats = true;
  const enabledStats = await apply({ update: { update_id: 53, message: { text: '/stats' } }, idempotencyKey: '123456:53' });
  assert.match(enabledStats.reply, /Ноябрь 2026/);
});
