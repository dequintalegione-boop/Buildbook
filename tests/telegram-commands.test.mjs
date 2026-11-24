import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { classifyTelegramCommand, TELEGRAM_HELP_TEXT } from '../host/telegram-finance-command.mjs';
import { createTelegramCommandAdapter } from '../host/telegram-command-adapter.mjs';
import { createTelegramReplySender } from '../host/telegram-reply.mjs';
import { createTelegramInboxProcessor } from '../host/telegram-inbox-processor.mjs';

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

test('classifier accepts help, stats and finance, and stays quiet for plain text', () => {
  assert.deepEqual(classifyTelegramCommand('/help'), { type: 'help' });
  assert.deepEqual(classifyTelegramCommand('/статистика'), { type: 'stats', month: null });
  assert.deepEqual(classifyTelegramCommand('/stats 2026-11'), { type: 'stats', month: '2026-11' });
  assert.deepEqual(classifyTelegramCommand('/доход 10 Текст'), { type: 'finance' });
  assert.equal(classifyTelegramCommand('привет'), null);
  assert.throws(() => classifyTelegramCommand('/статистика ноябрь'), /ГГГГ-ММ/);
  assert.throws(() => classifyTelegramCommand('/unknown'), /Неизвестная команда/);
});

test('finance command commits once and returns a confirmation reply', async () => {
  const store = makeStore(profile);
  const apply = createTelegramCommandAdapter({
    profileStore: store,
    now: () => new Date(2026, 10, 24, 9, 0, 0),
  });
  const update = { message: { text: '/расход 40 Обед' } };
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
  });
  const current = await apply({ update: { message: { text: '/статистика' } }, idempotencyKey: '123456:9' });
  const selected = await apply({ update: { message: { text: '/месяц 2026-10' } }, idempotencyKey: '123456:10' });
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
  const apply = createTelegramCommandAdapter({ profileStore: store, now: () => new Date(2026, 10, 24) });
  const help = await apply({ update: { message: { text: '/start' } }, idempotencyKey: '123456:11' });
  assert.equal(help.reply, TELEGRAM_HELP_TEXT);
  await assert.rejects(
    apply({ update: { message: { text: 'просто текст' } }, idempotencyKey: '123456:12' }),
    error => error.permanent === true && error.reply === undefined,
  );
  await assert.rejects(
    apply({ update: { message: { text: '/доход' } }, idempotencyKey: '123456:13' }),
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
    apply({ update: { message: { text: 'привет' } }, idempotencyKey: '123456:plain' }),
    error => {
      assert.equal(error.code, 'IGNORED_TELEGRAM_TEXT');
      assert.equal(error.permanent, true);
      assert.equal(error.reply, '');
      return true;
    },
  );
  assert.equal(store.snapshot().profile.state.tx.length, profile.state.tx.length);
});
