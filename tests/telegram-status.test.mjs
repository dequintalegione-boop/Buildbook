import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramStatus } from '../host/telegram-status.mjs';

test('status exposes operational counts without retaining raw update data', () => {
  const status = createTelegramStatus({ now: () => '2026-01-01T00:00:00.000Z' });
  status.started();
  status.cycle({ processed: 2, inbox: { pending: 1, completed: 2 } });
  const snapshot = status.snapshot({ running: true });
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.lastProcessed, 2);
  assert.deepEqual(snapshot.queue, { pending: 1, completed: 2 });
  assert.equal(snapshot.lastCycleAt, '2026-01-01T00:00:00.000Z');
});

test('status redacts Telegram bot tokens from error messages', () => {
  const status = createTelegramStatus();
  status.error(new Error('request failed https://api.telegram.org/bot123456:secret_token/getUpdates'));
  const snapshot = status.snapshot();
  assert.equal(snapshot.consecutiveFailures, 1);
  assert.match(snapshot.lastError.message, /\[redacted Telegram token\]/);
  assert.doesNotMatch(snapshot.lastError.message, /secret_token/);
});
