import test from 'node:test';
import { createHash } from 'node:crypto';
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

test('allows authenticated browser clients to preflight profile import POST', async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/api/profile/import`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:43127',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('access-control-allow-methods'), /POST/);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:43127');
});

test('rejects query and fragment components in local API request targets', async (t) => {
  const { base, request } = await fixture(t);
  assert.equal((await request(`${base}/api/health?token=not-accepted`)).status, 400);
});

test('accepts UTF-8 JSON charset and rejects other content type parameters', async (t) => {
  const { base, request } = await fixture(t);
  const accepted = await request(`${base}/api/profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ expectedRevision: 0, profile: { marker: 'utf8' } }),
  });
  assert.equal(accepted.status, 200);
  const rejected = await request(`${base}/api/profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json; charset=iso-8859-1' },
    body: '{}',
  });
  assert.equal(rejected.status, 415);
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
  const oversized = JSON.stringify({ expectedRevision: 0, profile: { data: 'x'.repeat(34 * 1024 * 1024) } });
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


test('rejects opaque file origins and malformed origins before checking credentials', async (t) => {
  const { base } = await fixture(t);
  const opaque = await fetch(`${base}/api/health`, { headers: { origin: 'null' } });
  assert.equal(opaque.status, 403);
  const malformed = await fetch(`${base}/api/health`, { headers: { origin: 'http://localhost.evil.example' } });
  assert.equal(malformed.status, 403);
});

test('rejects non-loopback Host headers even with a valid token', async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/api/health`, {
    headers: { host: 'attacker.example', authorization: 'Bearer test-local-api-token-0123456789abcdef' },
  });
  assert.equal(response.status, 403);
});

test('rejects bearer tokens with altered scheme, extra whitespace, or trailing data', async (t) => {
  const { base } = await fixture(t);
  for (const authorization of [
    'bearer test-local-api-token-0123456789abcdef',
    'Bearer  test-local-api-token-0123456789abcdef',
    'Bearer test-local-api-token-0123456789abcdef extra',
  ]) {
    const response = await fetch(`${base}/api/health`, { headers: { authorization } });
    assert.equal(response.status, 401);
  }
});

test('applies browser isolation headers to successful and rejected API responses', async (t) => {
  const { base } = await fixture(t);
  for (const response of [
    await fetch(`${base}/api/health`),
    await fetch(`${base}/api/health`, { headers: { origin: 'https://attacker.example' } }),
  ]) {
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  }
});


test('sanitizes Telegram status and never returns arbitrary error text or secret fields', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-api-status-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createProfileStore(join(dir, 'profile.json'));
  const token = 'test-local-api-token-0123456789abcdef';
  const api = createLocalApiServer({
    profileStore: store,
    accessToken: token,
    getTelegramStatus: () => ({
      running: true,
      startedAt: '2026-11-23T10:00:00.000Z',
      lastCycleAt: '2026-11-23T10:00:01.000Z',
      lastProcessed: 3,
      consecutiveFailures: 1,
      queue: { total: 4, pending: 1, processing: 1, completed: 2, rejected: 0, rawUpdate: 'private text' },
      lastError: { at: '2026-11-23T10:00:02.000Z', message: 'BOT_TOKEN=secret and private message' },
      botToken: 'secret-token',
      allowedUserIds: ['123456'],
    }),
  });
  const address = await api.listen();
  t.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;
  const unauthorized = await fetch(`${base}/api/telegram/status`);
  assert.equal(unauthorized.status, 401);
  const response = await fetch(`${base}/api/telegram/status`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(body.includes('secret-token'), false);
  assert.equal(body.includes('private text'), false);
  assert.equal(body.includes('BOT_TOKEN=secret'), false);
  assert.equal(body.includes('allowedUserIds'), false);
  assert.equal(body.includes('rawUpdate'), false);
  assert.deepEqual(JSON.parse(body), {
    running: true,
    startedAt: '2026-11-23T10:00:00.000Z',
    lastCycleAt: '2026-11-23T10:00:01.000Z',
    lastProcessed: 3,
    consecutiveFailures: 1,
    queue: { total: 4, pending: 1, processing: 1, completed: 2, rejected: 0 },
    lastError: {
      code: 'TELEGRAM_SERVICE_ERROR',
      message: 'Ошибка сервиса Telegram; подробности исключения не сохраняются.',
      at: '2026-11-23T10:00:02.000Z',
    },
  });
});

test('does not invoke Telegram status callback for unauthenticated requests', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-api-status-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const api = createLocalApiServer({
    profileStore: createProfileStore(join(dir, 'profile.json')),
    accessToken: 'test-local-api-token-0123456789abcdef',
    getTelegramStatus: () => { calls += 1; return { running: true }; },
  });
  const address = await api.listen();
  t.after(() => api.close());
  const response = await fetch(`http://127.0.0.1:${address.port}/api/telegram/status`);
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});


test('preflight responses carry the same browser isolation headers', async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/api/profile`, {
    method: 'OPTIONS',
    headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET' },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
});

function makeImportEnvelope(payload, sourceSchemaVersion = 5) {
  return {
    format: 'buildbook-profile-export',
    version: 1,
    sourceSchemaVersion,
    exportedAt: '2026-11-23T00:00:00.000Z',
    payload,
    sha256: createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex'),
  };
}

test('imports a valid profile export into an empty canonical profile', async (t) => {
  const { base, request } = await fixture(t);
  const payload = { state: { tx: [{ id: 'from-backup', amount: 125 }] }, logs: [], photos: {} };
  const response = await request(`${base}/api/profile/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, envelope: makeImportEnvelope(payload) }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revision: 1, imported: true });
  assert.deepEqual((await (await request(`${base}/api/profile`)).json()).profile, payload);
});

test('rejects profile import with a modified payload or unsupported envelope', async (t) => {
  const { base, request } = await fixture(t);
  const payload = { state: {}, logs: [], photos: {} };
  const envelope = makeImportEnvelope(payload);
  envelope.payload.state.tampered = true;
  const tampered = await request(`${base}/api/profile/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, envelope }),
  });
  assert.equal(tampered.status, 400);
  assert.match((await tampered.json()).error, /Контрольная сумма/);
  assert.deepEqual(await (await request(`${base}/api/profile`)).json(), { revision: 0, profile: null });
});

test('rejects extra import envelope fields and non-ISO dates before writing', async (t) => {
  const { base, request } = await fixture(t);
  const payload = { state: {}, logs: [], photos: {} };
  const envelope = makeImportEnvelope(payload);
  const extraEnvelope = await request(`${base}/api/profile/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, envelope: { ...envelope, hostToken: 'must-not-be-accepted' } }),
  });
  assert.equal(extraEnvelope.status, 400);

  const invalidDate = await request(`${base}/api/profile/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, envelope: { ...envelope, exportedAt: 'November 23, 2026' } }),
  });
  assert.equal(invalidDate.status, 400);

  const extraPayload = await request(`${base}/api/profile/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, envelope: makeImportEnvelope({ ...payload, extra: true }) }),
  });
  assert.equal(extraPayload.status, 400);
  assert.deepEqual(await (await request(`${base}/api/profile`)).json(), { revision: 0, profile: null });
});

test('rejects impossible ISO calendar dates without writing a profile', async (t) => {
  const { base, request } = await fixture(t);
  const envelope = makeImportEnvelope({ state: {}, logs: [], photos: {} });
  for (const exportedAt of [
    '2026-02-30T10:00:00.000Z',
    '2026-13-01T10:00:00.000Z',
    '2026-01-01T25:00:00.000Z',
    '2026-01-01T10:00:00+24:00',
  ]) {
    const response = await request(`${base}/api/profile/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, envelope: { ...envelope, exportedAt } }),
    });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(await (await request(`${base}/api/profile`)).json(), { revision: 0, profile: null });
});

test('refuses normal import into a populated profile without changing it', async (t) => {
  const { base, request } = await fixture(t);
  await request(`${base}/api/profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, profile: { marker: 'keep' } }),
  });
  const payload = { state: {}, logs: [], photos: {} };
  const response = await request(`${base}/api/profile/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 1, envelope: makeImportEnvelope(payload) }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'BUILD_BOOK_IMPORT_TARGET_NOT_EMPTY');
  assert.deepEqual((await (await request(`${base}/api/profile`)).json()).profile, { marker: 'keep' });
});

test('rejects stale import revisions and malformed import envelopes', async (t) => {
  const { base, request } = await fixture(t);
  const payload = { state: {}, logs: [], photos: {} };
  const stale = await request(`${base}/api/profile/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 2, envelope: makeImportEnvelope(payload) }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'BUILD_BOOK_STORAGE_CONFLICT');

  const malformed = await request(`${base}/api/profile/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, envelope: { ...makeImportEnvelope(payload), sourceSchemaVersion: -1 } }),
  });
  assert.equal(malformed.status, 400);
  const unsupported = await request(`${base}/api/profile/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, envelope: { ...makeImportEnvelope(payload), sourceSchemaVersion: 6 } }),
  });
  assert.equal(unsupported.status, 400);
  assert.deepEqual(await (await request(`${base}/api/profile`)).json(), { revision: 0, profile: null });
});


test('validates ISO 8601 export timezone offsets at the import boundary', async (t) => {
  const { base, request } = await fixture(t);
  const payload = { state: {}, logs: [], photos: {} };
  for (const exportedAt of [
    '2026-11-23T00:00:00+14:01',
    '2026-11-23T00:00:00-15:00',
    '2026-11-23T00:00:00+23:59',
  ]) {
    const envelope = makeImportEnvelope(payload);
    envelope.exportedAt = exportedAt;
    const response = await request(`${base}/api/profile/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, envelope }),
    });
    assert.equal(response.status, 400, exportedAt);
  }

  const envelope = makeImportEnvelope(payload);
  envelope.exportedAt = '2026-11-23T00:00:00+14:00';
  const accepted = await request(`${base}/api/profile/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, envelope }),
  });
  assert.equal(accepted.status, 200);
});


test('rejects malformed Host ports and non-origin Origin values', async (t) => {
  const { base } = await fixture(t);
  for (const host of ['localhost:65536', 'localhost:abc', '127.0.0.1:99999']) {
    const response = await fetch(base + '/api/health', {
      headers: { host, authorization: 'Bearer test-local-api-token-0123456789abcdef' },
    });
    assert.equal(response.status, 403, host);
  }
  for (const origin of [
    'http://localhost/path',
    'http://localhost/?x=1',
    'http://localhost/#fragment',
    'http://localhost.evil.example',
  ]) {
    const response = await fetch(base + '/api/health', {
      headers: { origin, authorization: 'Bearer test-local-api-token-0123456789abcdef' },
    });
    assert.equal(response.status, 403, origin);
  }
});
