import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfileStore } from '../host/profile-store.mjs';
import { createLocalApiServer } from '../host/local-api.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createProfileStore(join(dir, 'profile.json'));
  const api = createLocalApiServer({ profileStore: store });
  const address = await api.listen();
  t.after(() => api.close());
  return { api, base: `http://127.0.0.1:${address.port}` };
}

test('serves health and an empty profile', async (t) => {
  const { base } = await fixture(t);
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true, service: 'buildbook-local-host' });
  assert.deepEqual(await (await fetch(`${base}/api/profile`)).json(), { revision: 0, profile: null });
});

test('writes profile and returns incremented revision', async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/api/profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, profile: { state: { tx: [{ id: 'api-tx', amount: 100 }] } } }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revision: 1 });
  assert.deepEqual(await (await fetch(`${base}/api/profile`)).json(), {
    revision: 1,
    profile: { state: { tx: [{ id: 'api-tx', amount: 100 }] } },
  });
});

test('reports stale revision as HTTP 409 without replacing data', async (t) => {
  const { base } = await fixture(t);
  const put = profile => fetch(`${base}/api/profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, profile }),
  });
  await put({ marker: 'current' });
  const response = await put({ marker: 'stale' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'BUILD_BOOK_STORAGE_CONFLICT');
  assert.deepEqual((await (await fetch(`${base}/api/profile`)).json()).profile, { marker: 'current' });
});

test('rejects foreign origins, invalid content types, and malformed bodies', async (t) => {
  const { base } = await fixture(t);
  const foreign = await fetch(`${base}/api/profile`, { headers: { origin: 'https://example.com' } });
  assert.equal(foreign.status, 403);
  const wrongType = await fetch(`${base}/api/profile`, { method: 'PUT', body: '{}' });
  assert.equal(wrongType.status, 415);
  const malformed = await fetch(`${base}/api/profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{broken',
  });
  assert.equal(malformed.status, 400);
});

test('refuses to bind the API to a non-loopback interface', () => {
  assert.throws(() => createLocalApiServer({
    profileStore: { read: async () => ({}), write: async () => 1 },
    host: '0.0.0.0',
  }), /loopback/);
});


test('returns 413 for request bodies above the configured limit', async (t) => {
  const { base } = await fixture(t);
  const oversized = JSON.stringify({ expectedRevision: 0, profile: { data: 'x'.repeat(8 * 1024 * 1024) } });
  const response = await fetch(`${base}/api/profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: oversized,
  });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /превышает допустимый размер/);
});
