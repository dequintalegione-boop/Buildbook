import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfileStore } from '../host/profile-store.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-profile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { file: join(dir, 'profile.json'), store: createProfileStore(join(dir, 'profile.json')) };
}

test('new store reads an empty profile at revision zero', async (t) => {
  const { store } = await fixture(t);
  assert.deepEqual(await store.read(), { revision: 0, profile: null });
});

test('writes a profile and persists its incremented revision', async (t) => {
  const { file, store } = await fixture(t);
  const profile = { state: { tx: [{ id: 'tx-1', amount: 250 }] }, logs: [], photos: {} };
  assert.equal(await store.write(profile, 0), 1);
  assert.deepEqual(await store.read(), { revision: 1, profile });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, revision: 1, profile });
});

test('rejects stale writes without overwriting the latest profile', async (t) => {
  const { store } = await fixture(t);
  await store.write({ state: { tx: [] } }, 0);
  await assert.rejects(store.write({ state: { tx: [{ id: 'stale' }] } }, 0), (error) => {
    assert.equal(error.code, 'BUILD_BOOK_STORAGE_CONFLICT');
    assert.equal(error.expectedRevision, 0);
    assert.equal(error.currentRevision, 1);
    return true;
  });
  assert.deepEqual((await store.read()).profile, { state: { tx: [] } });
});

test('serializes concurrent writes and allows only one matching revision', async (t) => {
  const { store } = await fixture(t);
  const results = await Promise.allSettled([
    store.write({ marker: 'first' }, 0),
    store.write({ marker: 'second' }, 0),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'BUILD_BOOK_STORAGE_CONFLICT').length, 1);
  assert.equal((await store.read()).revision, 1);
});

test('rejects malformed profile values and invalid expected revisions', async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(store.write([], 0), TypeError);
  await assert.rejects(store.write({}, -1), TypeError);
});

test('refuses to read a canonical profile path that is a symbolic link', async (t) => {
  const { file, store } = await fixture(t);
  const external = file + '.external';
  await writeFile(external, JSON.stringify({ version: 1, revision: 4, profile: { marker: 'outside' } }), 'utf8');
  t.after(() => rm(external, { force: true }));
  await symlink(external, file);
  await assert.rejects(store.read(), /обычным файлом|ссылкой/i);
});

test('refuses to silently replace a malformed canonical profile file', async (t) => {
  const { file, store } = await fixture(t);
  await store.write({ marker: 'valid' }, 0);
  await (await import('node:fs/promises')).writeFile(file, '{"version":99,"revision":4,"profile":{}}', 'utf8');

  await assert.rejects(store.read(), /unknown or damaged format|неизвестный или повреждённый формат/i);
  await assert.rejects(store.write({ marker: 'replacement' }, 4), /unknown or damaged format|неизвестный или повреждённый формат/i);
  assert.match(await readFile(file, 'utf8'), /"version":99/);
});
