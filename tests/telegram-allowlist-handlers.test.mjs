import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTelegramAllowlistHandlers } from '../host/telegram-allowlist-handlers.mjs';

test('allowlist changes update the running gate, persist IDs and preserve comments across host restarts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'buildbook-allowlist-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appRoot = join(root, 'app');
  const dataDir = join(root, 'data');
  await mkdir(appRoot, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const envFile = join(appRoot, '.env');
  const profilePath = join(dataDir, 'profile.json');
  await writeFile(envFile, 'BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS=123456789\nOTHER_SETTING=keep-me\n', 'utf8');
  const env = {
    BUILDBOOK_PROFILE_PATH: profilePath,
    BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS: '123456789',
  };
  let liveIds = ['123456789'];
  const gate = {
    getAllowlist: () => [...liveIds],
    setAllowlist(ids) { liveIds = [...ids]; return [...liveIds]; },
  };
  const handlers = createTelegramAllowlistHandlers({ env, appRoot, getTelegram: () => gate });

  const saved = await handlers.setTelegramAllowlist([
    { id: '987654321', comment: 'Основной пользователь' },
    { id: '555123456', comment: 'Тестовый доступ' },
  ]);
  assert.deepEqual(liveIds, ['987654321', '555123456']);
  assert.deepEqual(env.BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS, '987654321,555123456');
  assert.deepEqual(saved.users, [
    { id: '987654321', comment: 'Основной пользователь' },
    { id: '555123456', comment: 'Тестовый доступ' },
  ]);
  const envText = await readFile(envFile, 'utf8');
  assert.match(envText, /BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS=987654321,555123456/);
  assert.match(envText, /OTHER_SETTING=keep-me/);

  const restartedHandlers = createTelegramAllowlistHandlers({
    env: { ...env, BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS: '987654321,555123456' },
    appRoot,
    getTelegram: () => null,
  });
  const restored = await restartedHandlers.getTelegramAllowlist();
  assert.deepEqual(restored.users, saved.users);
});

test('allowlist comments remain metadata and never alter the active numeric ID list', async t => {
  const root = await mkdtemp(join(tmpdir(), 'buildbook-allowlist-meta-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appRoot = join(root, 'app');
  const dataDir = join(root, 'data');
  await mkdir(appRoot, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(appRoot, '.env'), 'BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS=123456789\n', 'utf8');
  const env = { BUILDBOOK_PROFILE_PATH: join(dataDir, 'profile.json'), BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS: '123456789' };
  const gate = { getAllowlist: () => ['123456789'], setAllowlist() { throw new Error('unexpected update'); } };
  const handlers = createTelegramAllowlistHandlers({ env, appRoot, getTelegram: () => gate });
  const result = await handlers.getTelegramAllowlist();
  assert.deepEqual(result.users, [{ id: '123456789', comment: '' }]);
});
