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
