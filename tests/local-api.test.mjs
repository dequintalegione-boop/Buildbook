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
  const token = 'test-local-api-token-0123456789abcdef';
  const api = createLocalApiServer({ profileStore: store, accessToken: token });
  const address = await api.listen();
  t.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;
  const request = (url, options = {}) => fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  return { api, base, request };
}

test('rejects requests without a valid bearer token', async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 401);
});

test('sets restrictive browser security headers on API responses', async (t) => {
  const { base, request } = await fixture(t);
  const response = await request(`${base}/api/health`);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
});

test('serves health and an empty profile', async (t) => {
  const { base, request } = await fixture(t);
  assert.deepEqual(await (await request(`${base}/api/health`)).json(), { ok: true, service: 'buildbook-local-host' });
  assert.deepEqual(await (await request(`${base}/api/profile`)).json(), { revision: 0, profile: null });
});

test('writes profile and returns incremented revision', async (t) => {
  const { base, request } = await fixture(t);
  const response = await request(`${base}/api/profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, profile: { state: { tx: [{ id: 'api-tx', amount: 100 }] } } }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revision: 1 });
  assert.deepEqual(await (await request(`${base}/api/profile`)).json(), {
    revision: 1,
    profile: { state: { tx: [{ id: 'api-tx', amount: 100 }] } },
  });
});

test('reports stale revision as HTTP 409 without replacing data', async (t) => {
  const { base, request } = await fixture(t);
  const put = profile => request(`${base}/api/profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, profile }),
  });
  await put({ marker: 'current' });
  const response = await put({ marker: 'stale' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'BUILD_BOOK_STORAGE_CONFLICT');
  assert.deepEqual((await (await request(`${base}/api/profile`)).json()).profile, { marker: 'current' });
});

test('rejects query and fragment components in local API request targets', async (t) => {
  const { base, request } = await fixture(t);
  assert.equal((await request(`${base}/api/health?token=not-accepted`)).status, 400);
  assert.equal((await request(`${base}/api/health#fragment`)).status, 400);
});

test('rejects foreign origins, invalid content types, and malformed bodies', async (t) => {
  const { base, request } = await fixture(t);
  const foreign = await request(`${base}/api/profile`, { headers: { origin: 'https://example.com' } });
  assert.equal(foreign.status, 403);
  const wrongType = await request(`${base}/api/profile`, { method: 'PUT', body: '{}' });
  assert.equal(wrongType.status, 415);
  const malformed = await request(`${base}/api/profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{broken',
  });
  assert.equal(malformed.status, 400);
});

test('refuses to bind the API to a non-loopback interface', () => {
  assert.throws(() => createLocalApiServer({
    profileStore: { read: async () => ({}), write: async () => 1 },
    accessToken: 'test-local-api-token-0123456789abcdef',
    host: '0.0.0.0',
  }), /loopback/);
});

test('returns 413 for request bodies above the configured limit', async (t) => {
  const { base, request } = await fixture(t);
  const oversized = JSON.stringify({ expectedRevision: 0, profile: { data: 'x'.repeat(8 * 1024 * 1024) } });
  const response = await request(`${base}/api/profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: oversized,
  });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /превышает допустимый размер/);
});

test('serializes simultaneous writes with the same revision and preserves one winner', async (t) => {
  const { base, request } = await fixture(t);
  const put = marker => request(`${base}/api/profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, profile: { marker } }),
  });

  const responses = await Promise.all([put('first'), put('second')]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const stored = await (await request(`${base}/api/profile`)).json();
  assert.equal(stored.revision, 1);
  assert.ok(['first', 'second'].includes(stored.profile.marker));
});


test('supports authenticated browser preflight only from loopback origins', async (t) => {
  const { base } = await fixture(t);
  const allowed = await fetch(`${base}/api/profile`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:5173',
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.match(allowed.headers.get('access-control-allow-methods'), /PUT/);
  assert.match(allowed.headers.get('access-control-allow-headers'), /Authorization/);

  const denied = await fetch(`${base}/api/profile`, {
    method: 'OPTIONS',
    headers: { origin: 'https://attacker.example', 'access-control-request-method': 'PUT' },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});
