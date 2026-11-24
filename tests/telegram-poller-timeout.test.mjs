import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramPoller } from '../host/telegram-poller.mjs';

function makePoller(fetchImpl, options = {}) {
  return createTelegramPoller({
    botToken: '123456:secret',
    gate: { accept: async () => ({ accepted: true }) },
    offsetStore: { read: async () => null, write: async () => assert.fail('must not checkpoint') },
    fetchImpl,
    timeoutSeconds: 0,
    ...options,
  });
}

test('aborts a stalled Telegram long poll and reports a sanitized timeout', async () => {
  let observedSignal;
  const poller = makePoller((_url, options) => {
    observedSignal = options.signal;
    return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  }, { requestTimeoutMs: 5 });

  await assert.rejects(
    poller.pollOnce(),
    error => error.code === 'TELEGRAM_POLL_TIMEOUT' && !error.message.includes('secret'),
  );
  assert.equal(observedSignal.aborted, true);
});

test('validates the Telegram request timeout configuration', () => {
  assert.throws(() => makePoller(async () => ({}), { requestTimeoutMs: 0 }), /request timeout/);
});

test('caller cancellation remains distinguishable from a request timeout', async () => {
  const controller = new AbortController();
  const poller = makePoller((_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    controller.abort(new Error('host shutdown'));
  }), { requestTimeoutMs: 1000 });

  await assert.rejects(poller.pollOnce({ signal: controller.signal }), /host shutdown/);
});
