import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelegramOffsetStore } from '../host/telegram-offset-store.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'buildbook-offset-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, 'offset.json') };
}

test('offset checkpoint advances monotonically and survives reopening', async (t) => {
  const { file } = await fixture(t);
  const store = createTelegramOffsetStore(file);
  assert.equal(await store.read(), null);
  assert.equal(await store.write(42), 42);
  assert.equal(await createTelegramOffsetStore(file).read(), 42);
  await assert.rejects(store.write(41), /cannot move backwards/i);
});

test('concurrent offset writes serialize against the latest checkpoint', async (t) => {
  const { file } = await fixture(t);
  const store = createTelegramOffsetStore(file);
  const results = await Promise.allSettled([store.write(20), store.write(10)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(await store.read(), 20);
});

test('refuses a symlink as the Telegram offset file', async (t) => {
  const { file, directory } = await fixture(t);
  const external = join(directory, 'external.json');
  await writeFile(external, JSON.stringify({ version: 1, offset: 17 }), 'utf8');
  try {
    await symlink(external, file);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return;
    throw error;
  }
  await assert.rejects(createTelegramOffsetStore(file).read(), /regular file|special file/i);
});

test('treats only a missing offset path as an empty checkpoint', async (t) => {
  const { directory } = await fixture(t);
  const missing = createTelegramOffsetStore(join(directory, 'not-created', 'offset.json'));
  assert.equal(await missing.read(), null);

  const directoryPath = join(directory, 'offset-directory');
  const directoryStore = createTelegramOffsetStore(directoryPath);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(directoryPath);
  await assert.rejects(directoryStore.read(), /regular file|special file/i);
});

test('refuses corrupt offset checkpoints without resetting to null', async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, '{"version":1,"offset":-1}', 'utf8');
  await assert.rejects(createTelegramOffsetStore(file).read(), /corrupt Telegram offset/i);
});
