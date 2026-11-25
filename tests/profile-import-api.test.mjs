import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfileStore } from '../host/profile-store.mjs';
import { createLocalApiServer } from '../host/local-api.mjs';

const TOKEN = 'test-local-api-token-0123456789abcdef';
const payload = { state: { operations: [{ id: 'imported-1', amount: 125 }] }, logs: [], photos: {} };

function envelope(data = payload) {
  return {
    format: 'buildbook-profile-export',
    version: 1,
    sourceSchemaVersion: 5,
    exportedAt: '2026-11-25T12:00:00.000Z',
    payload: data,
    sha256: createHash('sha256').update(JSON.stringify(data), 'utf8').digest('hex'),
  };
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-profile-import-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const api = createLocalApiServer({
    profileStore: createProfileStore(join(dir, 'profile.json')),
    accessToken: TOKEN,
  });
  const address = await api.listen();
  t.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;
  const bootstrap = await fetch(base + '/api/session/bootstrap', {
    method: 'POST',
    headers: { origin: base, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const importProfile = (body) => fetch(base + '/api/profile/import', {
    method: 'POST',
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { base, cookie, importProfile };
}

test('imports a checksum-valid profile into empty canonical storage and verifies readback', async t => {
  const { base, cookie, importProfile } = await fixture(t);
  const response = await importProfile({ expectedRevision: 0, envelope: envelope() });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revision: 1, imported: true, verified: true });
  const stored = await fetch(base + '/api/profile', { headers: { cookie } });
  assert.deepEqual(await stored.json(), { revision: 1, profile: payload });
});

test('rejects a tampered export checksum without writing any profile data', async t => {
  const { importProfile } = await fixture(t);
  const data = envelope();
  data.payload.state.operations[0].amount = 999;
  const response = await importProfile({ expectedRevision: 0, envelope: data });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Контрольная сумма/);
});

test('rejects import into a non-empty profile and preserves existing data', async t => {
  const { base, importProfile } = await fixture(t);
  const initial = await fetch(base + '/api/session/bootstrap', {
    method: 'POST',
    headers: { origin: base, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(initial.status, 200);
  const cookie = initial.headers.get('set-cookie').split(';')[0];
  const put = await fetch(base + '/api/profile', {
    method: 'PUT',
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, profile: { marker: 'keep-me' } }),
  });
  assert.equal(put.status, 200);
  const response = await importProfile({ expectedRevision: 1, envelope: envelope() });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'BUILD_BOOK_IMPORT_TARGET_NOT_EMPTY');
  const stored = await fetch(base + '/api/profile', { headers: { cookie } });
  assert.deepEqual(await stored.json(), { revision: 1, profile: { marker: 'keep-me' } });
});

test('rejects stale expected revision before import and leaves the profile untouched', async t => {
  const { base, importProfile } = await fixture(t);
  const bootstrap = await fetch(base + '/api/session/bootstrap', {
    method: 'POST',
    headers: { origin: base, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  });
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const put = await fetch(base + '/api/profile', {
    method: 'PUT',
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, profile: { marker: 'current' } }),
  });
  assert.equal(put.status, 200);
  const response = await importProfile({ expectedRevision: 0, envelope: envelope() });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'BUILD_BOOK_STORAGE_CONFLICT');
  const stored = await fetch(base + '/api/profile', { headers: { cookie } });
  assert.deepEqual(await stored.json(), { revision: 1, profile: { marker: 'current' } });
});
