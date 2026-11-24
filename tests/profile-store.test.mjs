import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

test('treats only a missing profile path as empty and refuses a directory at the profile path', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-profile-path-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const missingStore = createProfileStore(join(dir, 'not-created', 'profile.json'));
  assert.deepEqual(await missingStore.read(), { revision: 0, profile: null });

  const directoryPath = join(dir, 'profile-directory');
  const directoryStore = createProfileStore(directoryPath);
  await (await import('node:fs/promises')).mkdir(directoryPath);
  await assert.rejects(directoryStore.read(), /обычным файлом|ссылкой/i);
});

test('reads canonical profile through the verified opened file handle', async (t) => {
  const { store } = await fixture(t);
  await store.write({ marker: 'stable' }, 0);
  assert.deepEqual(await store.read(), { revision: 1, profile: { marker: 'stable' } });
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


test('creates canonical profile files with owner-only permissions on POSIX', async (t) => {
  if (process.platform === 'win32') return;
  const { file, store } = await fixture(t);
  await store.write({ marker: 'private' }, 0);
  const info = await stat(file);
  assert.equal(info.mode & 0o077, 0);
});


test('ignores an orphaned temporary file after an interrupted write and preserves the canonical revision', async (t) => {
  const { file, store } = await fixture(t);
  await store.write({ marker: 'committed-before-crash' }, 0);
  const orphan = join(dirname(file), '.profile.json.interrupted-write.tmp');
  await writeFile(orphan, JSON.stringify({ version: 1, revision: 99, profile: { marker: 'uncommitted' } }), 'utf8');

  assert.deepEqual(await store.read(), { revision: 1, profile: { marker: 'committed-before-crash' } });
  assert.equal(await store.write({ marker: 'next-commit' }, 1), 2);
  assert.deepEqual(await store.read(), { revision: 2, profile: { marker: 'next-commit' } });
  assert.match(await readFile(orphan, 'utf8'), /uncommitted/);
});


test('refuses 20 malformed canonical disk envelopes without replacing their bytes', async t => {
  const invalid = [
    '', '{', 'null', '[]', 'true', '0', '"profile"',
    '{"version":2,"revision":0,"profile":{}}',
    '{"version":1,"revision":-1,"profile":{}}',
    '{"version":1,"revision":1.5,"profile":{}}',
    '{"version":1,"revision":9007199254740992,"profile":{}}',
    '{"version":1,"revision":0,"profile":null}',
    '{"version":1,"revision":0,"profile":[]}',
    '{"version":1,"revision":0,"profile":"x"}',
    '{"version":1,"revision":"0","profile":{}}',
    '{"version":1,"profile":{}}',
    '{"revision":0,"profile":{}}',
    '{"version":1,"revision":0}',
    '{"version":1,"revision":0,"profile":false}',
    '{"version":1,"revision":0,"profile":{}} trailing',
    '{"version":1,"revision":0,"profile":{},"checksum":"wrong"}',
  ];
  for (const [index, raw] of invalid.entries()) {
    await t.test('invalid envelope ' + (index + 1), async t => {
      const { file, store } = await fixture(t);
      await writeFile(file, raw, 'utf8');
      await assert.rejects(store.read());
      await assert.rejects(store.write({ marker: 'must-not-replace' }, 0));
      assert.equal(await readFile(file, 'utf8'), raw);
    });
  }
});
