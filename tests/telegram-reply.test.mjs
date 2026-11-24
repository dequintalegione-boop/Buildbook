import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramReplySender } from '../host/telegram-reply.mjs';

test('reply sender aborts a stalled Bot API request with a safe timeout error', async () => {
  let receivedSignal;
  const sendReply = createTelegramReplySender({
    botToken: '123456:secret',
    timeoutMs: 5,
    fetchImpl(_url, options) {
      receivedSignal = options.signal;
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
  });

  await assert.rejects(
    sendReply({ chatId: '1001', text: 'Готово' }),
    error => error.code === 'TELEGRAM_REPLY_TIMEOUT' && !error.message.includes('secret'),
  );
  assert.equal(receivedSignal.aborted, true);
});

test('reply sender validates timeout configuration', () => {
  assert.throws(() => createTelegramReplySender({
    botToken: '123456:secret',
    timeoutMs: 0,
    fetchImpl: async () => ({}),
  }), /timeout must be an integer/);
});

test('reply sender does not wait for stalled HTTP error body cleanup', async () => {
  const sendReply = createTelegramReplySender({
    botToken: '123456:secret',
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      body: { cancel: () => new Promise(() => {}) },
    }),
  });

  await assert.rejects(
    sendReply({ chatId: '1001', text: 'Готово' }),
    error => error.code === 'TELEGRAM_REPLY_FAILED' && /HTTP 502/.test(error.message),
  );
});

test('reply sender accepts canonical numeric chat IDs and sends the expected payload', async () => {
  let request;
  const sendReply = createTelegramReplySender({
    botToken: '123456:secret',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options, body: JSON.parse(options.body) };
      return {
        ok: true,
        async json() { return { ok: true, result: { message_id: 42 } }; },
      };
    },
  });

  await sendReply({ chatId: '1001', text: 'Готово', replyToMessageId: 7 });
  assert.match(request.url, /\/sendMessage$/);
  assert.deepEqual(request.body, {
    chat_id: 1001,
    text: 'Готово',
    disable_web_page_preview: true,
    reply_to_message_id: 7,
  });
});

test('reply sender rejects non-canonical chat IDs before making a request', async () => {
  let calls = 0;
  const sendReply = createTelegramReplySender({
    botToken: '123456:secret',
    fetchImpl: async () => { calls += 1; return {}; },
  });

  for (const chatId of ['abc', '01001', '0', '-1', '1001x']) {
    await assert.rejects(sendReply({ chatId, text: 'Готово' }), /canonical numeric chat ID/);
  }
  assert.equal(calls, 0);
});
