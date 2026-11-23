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

test('status never retains arbitrary exception details', () => {
  const status = createTelegramStatus();
  const error = new Error('token=secret_value; local path=/home/user/private; Telegram text=rent 900');
  error.code = 'TOKEN_SECRET_123';
  status.error(error);
  const snapshot = status.snapshot();
  assert.equal(snapshot.consecutiveFailures, 1);
  assert.equal(snapshot.lastError.message, 'Ошибка сервиса Telegram; подробности исключения не сохраняются.');
  assert.equal(snapshot.lastError.code, 'TELEGRAM_SERVICE_ERROR');
  assert.doesNotMatch(snapshot.lastError.message, /secret_value|private|rent 900/);
});

test('successful cycle clears prior error and resets failure streak', () => {
  const status = createTelegramStatus();
  status.error(new Error('temporary failure'));
  status.cycle({ processed: 0, inbox: { pending: 0 } });
  const snapshot = status.snapshot();
  assert.equal(snapshot.lastError, null);
  assert.equal(snapshot.consecutiveFailures, 0);
});
