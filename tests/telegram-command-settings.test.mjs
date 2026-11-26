import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTelegramCommandSettingsStore, DEFAULT_TELEGRAM_COMMAND_SETTINGS } from '../host/telegram-command-settings.mjs';

test('command settings default to safe disabled financial commands and persist atomically', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-telegram-command-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'telegram-command-settings.json');
  const store = createTelegramCommandSettingsStore(path);
  assert.deepEqual(await store.read(), DEFAULT_TELEGRAM_COMMAND_SETTINGS);
  const saved = await store.write({ income: true, expense: false, stats: true, help: true });
  assert.deepEqual(saved, { income: true, expense: false, stats: true, help: true });
  const reopened = createTelegramCommandSettingsStore(path);
  assert.deepEqual(await reopened.read(), saved);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 1);
});

test('command settings reject unknown fields and non-boolean values', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-telegram-command-settings-invalid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createTelegramCommandSettingsStore(join(dir, 'settings.json'));
  await assert.rejects(store.write({ income: true, expense: false, stats: false, help: true, shell: true }), /invalid fields/i);
  await assert.rejects(store.write({ income: 'yes', expense: false, stats: false, help: true }), /must be boolean/i);
});

test('command settings store requires an absolute path', () => {
  assert.throws(() => createTelegramCommandSettingsStore('relative/settings.json'), /absolute/);
});
