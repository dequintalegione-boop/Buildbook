import test from 'node:test';
import assert from 'node:assert/strict';
import { readTelegramServiceConfig } from '../host/telegram-config.mjs';

const valid = {
  BUILDBOOK_TELEGRAM_BOT_TOKEN: '123456:secret_token_value',
  BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS: '1001, 1002,1001',
  BUILDBOOK_TELEGRAM_INBOX_PATH: '/home/test/.local/share/buildbook/telegram-inbox.json',
  BUILDBOOK_TELEGRAM_OFFSET_PATH: '/home/test/.local/share/buildbook/telegram-offset.json',
  BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH: '/home/test/.local/share/buildbook/telegram-service.lock',
};

test('parses host-only configuration and deduplicates allowlist IDs', () => {
  const config = readTelegramServiceConfig(valid);
  assert.equal(config.botId, '123456');
  assert.deepEqual(config.allowedUserIds, ['1001', '1002']);
  assert.equal(config.timeoutSeconds, 25);
  assert.equal(config.intervalMs, 1000);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.allowedUserIds));
});

test('rejects missing secrets, malformed allowlists, and unsafe paths', () => {
  assert.throws(() => readTelegramServiceConfig({ ...valid, BUILDBOOK_TELEGRAM_BOT_TOKEN: '' }), /is required/);
  assert.throws(() => readTelegramServiceConfig({ ...valid, BUILDBOOK_TELEGRAM_BOT_TOKEN: '012345:secret_token_value' }), /invalid format/);
  assert.throws(() => readTelegramServiceConfig({ ...valid, BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS: '1001, nope' }), /numeric IDs/);
  assert.throws(() => readTelegramServiceConfig({ ...valid, BUILDBOOK_TELEGRAM_INBOX_PATH: 'data/inbox.json' }), /absolute/);
  assert.throws(() => readTelegramServiceConfig({ ...valid, BUILDBOOK_TELEGRAM_OFFSET_PATH: valid.BUILDBOOK_TELEGRAM_INBOX_PATH }), /overlap/);
  assert.throws(() => readTelegramServiceConfig({ ...valid, BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH: valid.BUILDBOOK_TELEGRAM_OFFSET_PATH }), /overlap/);
  assert.throws(() => readTelegramServiceConfig({ ...valid, BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH: 'relative.lock' }), /absolute/);
});

test('validates numeric runtime options', () => {
  assert.throws(() => readTelegramServiceConfig({ ...valid, BUILDBOOK_TELEGRAM_TIMEOUT_SECONDS: '51' }), /between 0 and 50/);
  assert.throws(() => readTelegramServiceConfig({ ...valid, BUILDBOOK_TELEGRAM_INTERVAL_MS: '1.5' }), /integer/);
  assert.throws(() => readTelegramServiceConfig({ ...valid, BUILDBOOK_TELEGRAM_RETRY_BASE_MS: '5000', BUILDBOOK_TELEGRAM_RETRY_MAX_MS: '1000' }), /at least the retry base/);
});
