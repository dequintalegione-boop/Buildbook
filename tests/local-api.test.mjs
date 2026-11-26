import test from 'node:test';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfileStore } from '../host/profile-store.mjs';
import { createLocalApiServer } from '../host/local-api.mjs';

function requestWithHost(base, host) {
  const url = new URL('/api/health', base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method: 'GET', headers: { host, authorization: 'Bearer test-local-api-token-0123456789abcdef' } }, response => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createProfileStore(join(dir, 'profile.json'));
  const token = 'test-local-api-token-0123456789abcdef';
  const api = createLocalApiServer({ profileStore: store, accessToken: token, launchLocalAction: options.launchLocalAction || null, getTelegramStatus: options.getTelegramStatus || null, startTelegram: options.startTelegram || null, stopTelegram: options.stopTelegram || null, restartTelegram: options.restartTelegram || null, verifyTelegramBot: options.verifyTelegramBot || null, configureTelegram: options.configureTelegram || null, getActivityLog: options.getActivityLog || null, recordActivity: options.recordActivity || null, getTelegramAllowlist: options.getTelegramAllowlist || null, setTelegramAllowlist: options.setTelegramAllowlist || null });
  const address = await api.listen();
  t.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;
  const bootstrap = await fetch(base + '/api/session/bootstrap', {
    method: 'POST',
    headers: {
      origin: base,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const request = (url, options = {}) => fetch(url, {
    ...options,
    headers: { cookie, ...(options.headers || {}) },
  });
  return { api, base, request, cookie };
}


test('serves only the fixed public UI allowlist without exposing host data or secrets', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-static-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Buildbook test</title>');
  await writeFile(join(dir, '.env'), 'BUILDBOOK_LOCAL_API_TOKEN=must-not-leak');
  await writeFile(join(dir, 'profile.json'), '{"private":true}');
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await writeFile(join(dir, 'scripts', 'manage-buildbook-telegram.bat'), '@echo off\\r\\n');
  await writeFile(join(dir, 'scripts', 'manage-buildbook-telegram.ps1'), 'Write-Host \'safe helper\'');
  await writeFile(join(dir, 'scripts', 'unlisted-helper.ps1'), 'private helper');
  const store = createProfileStore(join(dir, 'canonical-profile.json'));
  const api = createLocalApiServer({
    profileStore: store,
    accessToken: 'test-local-api-token-0123456789abcdef',
    staticRoot: dir,
  });
  const address = await api.listen();
  t.after(() => api.close());
  const base = 'http://127.0.0.1:' + address.port;

  const root = await fetch(base + '/');
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type'), /^text\/html/);
  assert.equal(await root.text(), '<!doctype html><title>Buildbook test</title>');
  assert.equal(root.headers.get('x-content-type-options'), 'nosniff');
  assert.match(root.headers.get('content-security-policy'), /frame-ancestors 'none'/);

  const head = await fetch(base + '/index.html', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  for (const path of ['/.env', '/profile.json', '/data/profile.json', '/host/local-api.mjs', '/scripts/unlisted-helper.ps1', '/unknown.js']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  const manager = await fetch(base + '/scripts/manage-buildbook-telegram.bat');
  assert.equal(manager.status, 200);
  assert.ok(manager.headers.get('content-type').startsWith('text/plain'));
  assert.equal(manager.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await manager.text(), /@echo off/);
  const managerScript = await fetch(base + '/scripts/manage-buildbook-telegram.ps1');
  assert.equal(managerScript.status, 200);
  assert.match(await managerScript.text(), /safe helper/);
  const helperHead = await fetch(base + '/scripts/manage-buildbook-telegram.bat', { method: 'HEAD' });
  assert.equal(helperHead.status, 200);
  assert.equal(await helperHead.text(), '');
  const helperPost = await fetch(base + '/scripts/manage-buildbook-telegram.bat', { method: 'POST' });
  assert.equal(helperPost.status, 405);
  const helperScriptPost = await fetch(base + '/scripts/manage-buildbook-telegram.ps1', { method: 'POST' });
  assert.equal(helperScriptPost.status, 405);
  const helperPut = await fetch(base + '/scripts/manage-buildbook-telegram.ps1', { method: 'PUT', body: 'must not be accepted' });
  assert.equal(helperPut.status, 405);
  assert.equal((await fetch(base + '/api/profile')).status, 401);
});

test('rejects legacy detached Telegram helpers; Telegram setup is available through in-app API routes', async t => {
  const launched = [];
  const { base, request } = await fixture(t, {
    launchLocalAction: async action => { launched.push(action); },
  });
  const legacy = await request(base + '/api/local-actions/telegram-manage', { method: 'POST' });
  assert.equal(legacy.status, 404);
  const denied = await request(base + '/api/local-actions/run-arbitrary-command', { method: 'POST' });
  assert.equal(denied.status, 404);
  assert.deepEqual(launched, []);
});

test('rejects requests without a browser session', async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 401);
});

test('bootstrap bearer cannot authorize profile or status requests after exchange', async t => {
  const { base } = await fixture(t);
  const headers = { authorization: 'Bearer test-local-api-token-0123456789abcdef' };
  assert.equal((await fetch(base + '/api/health', { headers })).status, 401);
  assert.equal((await fetch(base + '/api/profile', { headers })).status, 401);
  assert.equal((await fetch(base + '/api/telegram/status', { headers })).status, 401);
});

test('allows same-origin PWA bootstrap only when the local host serves the UI', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-pwa-bootstrap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Buildbook</title>');
  const api = createLocalApiServer({
    profileStore: createProfileStore(join(dir, 'profile.json')),
    accessToken: 'test-local-api-token-0123456789abcdef',
    staticRoot: dir,
  });
  const address = await api.listen();
  t.after(() => api.close());
  const base = 'http://127.0.0.1:' + address.port;

  const paired = await fetch(base + '/api/session/bootstrap-local', {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(paired.status, 200);
  assert.deepEqual(await paired.json(), { ok: true, expiresIn: 12 * 60 * 60 * 1000, method: 'same-origin' });
  const cookie = paired.headers.get('set-cookie');
  assert.match(cookie, /^buildbook_local_session=[A-Za-z0-9_-]{40,}; HttpOnly; SameSite=Strict; Path=\/api; Max-Age=43200$/);
  assert.equal((await fetch(base + '/api/health', { headers: { cookie: cookie.split(';')[0] } })).status, 200);

  const wrongOrigin = await fetch(base + '/api/session/bootstrap-local', {
    method: 'POST',
    headers: { origin: 'http://localhost:9999', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(wrongOrigin.status, 403);
});

test('does not allow local PWA bootstrap when the API does not serve the UI', async t => {
  const { base } = await fixture(t);
  const response = await fetch(base + '/api/session/bootstrap-local', {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 403);
});

test('exchanges the bootstrap bearer for an HttpOnly browser session', async (t) => {
  const { base } = await fixture(t);
  const bootstrap = await fetch(base + '/api/session/bootstrap', {
    method: 'POST',
    headers: {
      origin: base,
      authorization: 'Bearer test-local-api-token-0123456789abcdef',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(bootstrap.status, 200);
  assert.deepEqual(await bootstrap.json(), { ok: true, expiresIn: 12 * 60 * 60 * 1000 });
  const cookie = bootstrap.headers.get('set-cookie');
  assert.match(cookie, /^buildbook_local_session=[A-Za-z0-9_-]{40,}; HttpOnly; SameSite=Strict; Path=\/api; Max-Age=43200$/);
  const withoutSession = await fetch(base + '/api/health');
  assert.equal(withoutSession.status, 401);
  const withSession = await fetch(base + '/api/health', { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(withSession.status, 200);

  const closed = await fetch(base + '/api/session/close', {
    method: 'POST',
    headers: { origin: base, cookie: cookie.split(';')[0] },
  });
  assert.equal(closed.status, 200);
  const afterClose = await fetch(base + '/api/health', { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(afterClose.status, 401);
});

test('requires the exact local origin and bootstrap secret for browser session exchange', async (t) => {
  const { base } = await fixture(t);
  const noOrigin = await fetch(base + '/api/session/bootstrap', {
    method: 'POST',
    headers: { authorization: 'Bearer test-local-api-token-0123456789abcdef', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(noOrigin.status, 403);
  const wrongToken = await fetch(base + '/api/session/bootstrap', {
    method: 'POST',
    headers: { origin: base, authorization: 'Bearer wrong-bootstrap-token-value-123456', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(wrongToken.status, 401);
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
      origin: base,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('access-control-allow-methods'), /POST/);
  assert.equal(response.headers.get('access-control-allow-origin'), base);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
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
  assert.match((await response.json()).error, /слишком большой Content-Length|превышает допустимый размер/);
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
      origin: base,
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), base);
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
  const response = await requestWithHost(base, 'attacker.example');
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
  const bootstrap = await fetch(base + '/api/session/bootstrap', {
    method: 'POST',
    headers: {
      origin: base,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${base}/api/telegram/status`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(body.includes('secret-token'), false);
  assert.equal(body.includes('private text'), false);
  assert.equal(body.includes('BOT_TOKEN=secret'), false);
  assert.equal(body.includes('allowedUserIds'), false);
  assert.equal(body.includes('rawUpdate'), false);
  assert.deepEqual(JSON.parse(body), {
    enabled: true,
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
    headers: { origin: base, 'access-control-request-method': 'GET' },
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

test('accepts UTF-8 JSON charset for profile import and rejects other charsets', async (t) => {
  const { base, request } = await fixture(t);
  const payload = { state: {}, logs: [], photos: {} };
  const accepted = await request(base + '/api/profile/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ expectedRevision: 0, envelope: makeImportEnvelope(payload) }),
  });
  assert.equal(accepted.status, 200);

  const rejected = await request(base + '/api/profile/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=iso-8859-1' },
    body: JSON.stringify({ expectedRevision: 1, envelope: makeImportEnvelope(payload) }),
  });
  assert.equal(rejected.status, 415);
});

test('imports a valid profile export into an empty canonical profile', async (t) => {
  const { base, request } = await fixture(t);
  const payload = { state: { tx: [{ id: 'from-backup', amount: 125 }] }, logs: [], photos: {} };
  const response = await request(`${base}/api/profile/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, envelope: makeImportEnvelope(payload) }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revision: 1, imported: true, verified: true });
  assert.deepEqual((await (await request(`${base}/api/profile`)).json()).profile, payload);
});

test('reports a failed canonical read-back after profile import instead of claiming success', async (t) => {
  let writes = 0;
  const profileStore = {
    async read() {
      return writes === 0
        ? { revision: 0, profile: null }
        : { revision: 1, profile: { state: { unexpected: true }, logs: [], photos: {} } };
    },
    async write() { writes += 1; return 1; },
  };
  const api = createLocalApiServer({
    profileStore,
    accessToken: 'test-local-api-token-0123456789abcdef',
  });
  const address = await api.listen();
  t.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;
  const payload = { state: { tx: [{ id: 'verify-me' }] }, logs: [], photos: {} };
  const bootstrap = await fetch(base + '/api/session/bootstrap', {
    method: 'POST',
    headers: {
      origin: base,
      authorization: 'Bearer test-local-api-token-0123456789abcdef',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const response = await fetch(base + '/api/profile/import', {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ expectedRevision: 0, envelope: makeImportEnvelope(payload) }),
  });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).code, 'BUILD_BOOK_IMPORT_READBACK_FAILED');
  assert.equal(writes, 1);
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
    const response = await requestWithHost(base, host);
    assert.equal(response.status, 403, host);
  }
  const mismatchedPort = new URL(base);
  mismatchedPort.port = String(Number(mismatchedPort.port) === 1 ? 2 : 1);
  const sameHostWrongPort = await fetch(base + '/api/health', {
    headers: {
      origin: mismatchedPort.origin,
      authorization: 'Bearer test-local-api-token-0123456789abcdef',
    },
  });
  assert.equal(sameHostWrongPort.status, 403);

  for (const origin of [
    'http://localhost:1',
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


test('expires HttpOnly sessions and rotates an existing browser session on reconnect', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-session-expiry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createProfileStore(join(dir, 'profile.json'));
  const token = 'test-local-api-token-0123456789abcdef';
  let clock = 1_000;
  const api = createLocalApiServer({
    profileStore: store,
    accessToken: token,
    sessionTtlMs: 2_000,
    now: () => clock,
  });
  const address = await api.listen();
  t.after(() => api.close());
  const base = `http://127.0.0.1:${address.port}`;
  const origin = base;
  const bootstrap = (cookie = '') => fetch(base + '/api/session/bootstrap', {
    method: 'POST',
    headers: {
      origin,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: '{}',
  });

  const first = await bootstrap();
  assert.equal(first.status, 200);
  const firstCookie = first.headers.get('set-cookie');
  assert.match(firstCookie, /HttpOnly/);
  assert.match(firstCookie, /SameSite=Strict/);
  assert.match(firstCookie, /Max-Age=2/);
  const firstValue = firstCookie.split(';')[0];

  const renewed = await bootstrap(firstValue);
  assert.equal(renewed.status, 200);
  const renewedValue = renewed.headers.get('set-cookie').split(';')[0];
  assert.notEqual(renewedValue, firstValue);
  assert.equal((await fetch(base + '/api/health', { headers: { cookie: firstValue } })).status, 401);
  assert.equal((await fetch(base + '/api/health', { headers: { cookie: renewedValue } })).status, 200);

  clock += 2_001;
  assert.equal((await fetch(base + '/api/health', { headers: { cookie: renewedValue } })).status, 401);

  const afterExpiry = await bootstrap();
  assert.equal(afterExpiry.status, 200);
  const freshValue = afterExpiry.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/health', { headers: { cookie: freshValue } })).status, 200);
});



test('rejects duplicate or malformed session cookies instead of accepting the first value', async t => {
  const { base, request } = await fixture(t);
  const token = 'test-local-api-token-0123456789abcdef';
  const bootstrap = await request(base + '/api/session/bootstrap', {
    method: 'POST',
    headers: {
      origin: base,
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const value = cookie.slice(cookie.indexOf('=') + 1);

  for (const header of [
    cookie + '; buildbook_local_session=attacker-controlled',
    cookie + '; buildbook_local_session=' + value,
    'buildbook_local_session=not-a-valid-session-id',
  ]) {
    const response = await request(base + '/api/health', { headers: { cookie: header } });
    assert.equal(response.status, 401, header);
  }

  const ambiguousBootstrap = await request(base + '/api/session/bootstrap', {
    method: 'POST',
    headers: {
      origin: base,
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      cookie: cookie + '; buildbook_local_session=' + value,
    },
    body: '{}',
  });
  assert.equal(ambiguousBootstrap.status, 400);
});


test('preserves compare-and-swap semantics across 20 concurrent API write races', async t => {
  for (let round = 1; round <= 20; round += 1) {
    await t.test('race ' + round, async t => {
      const { base, request } = await fixture(t);
      const write = marker => request(base + '/api/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 0, profile: { marker } }),
      });
      const results = await Promise.all([write('left-' + round), write('right-' + round)]);
      const statuses = results.map(response => response.status).sort();
      assert.deepEqual(statuses, [200, 409]);
      const conflict = results.find(response => response.status === 409);
      assert.equal((await conflict.json()).code, 'BUILD_BOOK_STORAGE_CONFLICT');
      const final = await (await request(base + '/api/profile')).json();
      assert.equal(final.revision, 1);
      assert.ok(['left-' + round, 'right-' + round].includes(final.profile.marker));
    });
  }
});


test('allows exactly one winner in 20 concurrent empty-profile import races', async t => {
  for (let round = 1; round <= 20; round += 1) {
    await t.test('import race ' + round, async t => {
      const { base, request } = await fixture(t);
      const envelope = makeImportEnvelope({
        state: { tx: [{ id: 'import-' + round, amount: round }] },
        logs: [],
        photos: {},
      });
      const importOnce = () => request(base + '/api/profile/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 0, envelope }),
      });
      const responses = await Promise.all([importOnce(), importOnce()]);
      const statuses = responses.map(response => response.status).sort();
      assert.deepEqual(statuses, [200, 409]);
      const successful = responses.find(response => response.status === 200);
      assert.deepEqual(await successful.json(), { revision: 1, imported: true, verified: true });
      const final = await (await request(base + '/api/profile')).json();
      assert.equal(final.revision, 1);
      assert.deepEqual(final.profile.state.tx, [{ id: 'import-' + round, amount: round }]);
    });
  }
});


test('returns completed local helper output to the in-app client', async t => {
  const { base, request } = await fixture(t, {
    launchLocalAction: async action => ({
      ok: true,
      completed: true,
      message: 'Команда выполнена.',
      output: 'Автозапуск Buildbook Local Host установлен.',
    }),
  });
  const response = await request(base + '/api/local-actions/host-autostart-install', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    action: 'host-autostart-install',
    message: 'Команда выполнена.',
    output: 'Автозапуск Buildbook Local Host установлен.',
  });
});


test('returns local helper failures to the in-app client', async t => {
  const { base, request } = await fixture(t, {
    launchLocalAction: async () => {
      const error = new Error('Task Scheduler rejected the registration request.');
      error.stderr = 'Access is denied.';
      throw error;
    },
  });
  const response = await request(base + '/api/local-actions/host-autostart-install', { method: 'POST' });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.code, 'LOCAL_ACTION_FAILED');
  assert.match(body.error, /Access is denied/);
});


test('diagnostics report host resources and distinguish a configured stopped bot', async t => {
  const { base, request } = await fixture(t, {
    getTelegramStatus: () => ({
      configured: true,
      enabled: false,
      running: false,
      startedAt: '2026-11-26T08:00:00.000Z',
      lastProcessed: 4,
      queue: { total: 10, pending: 1, processing: 0, completed: 8, rejected: 1 },
    }),
  });
  const response = await request(base + '/api/diagnostics');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.telegram.configured, true);
  assert.equal(body.telegram.running, false);
  assert.equal(body.telegram.completed, 8);
  assert.equal(body.telegram.total, 10);
  assert.equal(body.telegram.lastProcessed, 4);
  assert.ok(body.host.uptimeSeconds >= 0);
  assert.ok(body.host.memoryRssBytes > 0);
  assert.ok(body.host.heapUsedBytes > 0);
});


test('local helper actions are added to the authenticated activity journal', async t => {
  const events = [];
  const { base, request } = await fixture(t, {
    launchLocalAction: async () => ({ ok: true, completed: true, message: 'Автозапуск установлен.' }),
    recordActivity: async event => { events.push({ ...event, id: 'event-1', at: '2026-11-26T10:00:00.000Z' }); },
    getActivityLog: async () => events,
  });
  const action = await request(base + '/api/local-actions/host-autostart-install', { method: 'POST' });
  assert.equal(action.status, 200);
  const journal = await request(base + '/api/activity');
  assert.equal(journal.status, 200);
  const body = await journal.json();
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].action, 'local_helper_host_autostart_install');
  assert.equal(body.events[0].status, 'success');
  assert.equal(body.events[0].message, 'Установка автозапуска Windows выполнена.');
});


test('local helper activity journal never stores helper-provided output or secrets', async t => {
  const events = [];
  const secret = 'SHOULD_NOT_APPEAR_IN_ACTIVITY_LOG';
  const { base, request } = await fixture(t, {
    launchLocalAction: async () => ({ ok: true, completed: true, message: secret, output: secret }),
    recordActivity: async event => { events.push({ ...event, id: 'event-2', at: '2026-11-26T10:00:00.000Z' }); },
    getActivityLog: async () => events,
  });
  const action = await request(base + '/api/local-actions/host-autostart-install', { method: 'POST' });
  assert.equal(action.status, 200);
  const journal = await request(base + '/api/activity');
  const body = await journal.json();
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].message.includes(secret), false);
  assert.equal(JSON.stringify(body.events).includes(secret), false);
});


test('restarts Telegram through the authenticated local API and records the action', async t => {
  const events = [];
  let restartCalls = 0;
  const { base, request } = await fixture(t, {
    restartTelegram: async () => { restartCalls += 1; },
    getTelegramStatus: () => ({ configured: true, enabled: true, running: true }),
    recordActivity: async event => { events.push(event); },
  });
  const response = await request(base + '/api/telegram/restart', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, action: 'restart', running: true });
  assert.equal(restartCalls, 1);
  assert.deepEqual(events, [{
    action: 'telegram_restart',
    status: 'success',
    message: 'Telegram перезапущен.',
  }]);
});

test('rejects Telegram restart when the host has no restart handler', async t => {
  const { base, request } = await fixture(t);
  const response = await request(base + '/api/telegram/restart', { method: 'POST' });
  assert.equal(response.status, 409);
});


test('verifies a Telegram bot token without reflecting the secret and records a sanitized event', async t => {
  const events = [];
  const secret = '123456789:AA_this_is_a_test_bot_token_value';
  let verifiedToken = '';
  const { base, request } = await fixture(t, {
    verifyTelegramBot: async token => {
      verifiedToken = token;
      return { id: '123456789', firstName: 'Buildbook Bot', username: 'buildbook_test_bot' };
    },
    recordActivity: async event => { events.push(event); },
  });

  const response = await request(base + '/api/telegram/bot/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: secret }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: true,
    bot: { id: '123456789', firstName: 'Buildbook Bot', username: 'buildbook_test_bot' },
  });
  assert.equal(verifiedToken, secret);
  assert.equal(JSON.stringify(body).includes(secret), false);
  assert.deepEqual(events, [{
    action: 'telegram_bot_verify',
    status: 'success',
    message: 'Токен Telegram-бота успешно проверен.',
  }]);
});

test('rejects malformed Telegram verification payloads before calling Telegram Bot API', async t => {
  let calls = 0;
  const { base, request } = await fixture(t, {
    verifyTelegramBot: async () => { calls += 1; return { id: '123456789', firstName: 'Bot' }; },
  });
  for (const payload of [{ token: 'bad' }, { token: '123456789:AA_valid_token_value_123456', extra: true }, { token: 123 }]) {
    const response = await request(base + '/api/telegram/bot/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test('saves Telegram setup through the authenticated route without returning the bot token', async t => {
  const events = [];
  const secret = '123456789:AA_this_is_a_test_bot_token_value';
  let received = null;
  const { base, request } = await fixture(t, {
    configureTelegram: async config => {
      received = config;
      return { id: '123456789', firstName: 'Buildbook Bot', username: 'buildbook_test_bot' };
    },
    recordActivity: async event => { events.push(event); },
  });

  const response = await request(base + '/api/telegram/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: secret, userId: '42' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    configured: true,
    enabled: false,
    running: false,
    bot: { id: '123456789', firstName: 'Buildbook Bot', username: 'buildbook_test_bot' },
  });
  assert.deepEqual(received, { token: secret, userId: '42' });
  assert.equal(JSON.stringify(events).includes(secret), false);
  assert.deepEqual(events, [{
    action: 'telegram_setup',
    status: 'success',
    message: 'Настройки Telegram-бота сохранены.',
  }]);
});

test('rejects Telegram setup without a valid user ID and never invokes the configurator', async t => {
  let calls = 0;
  const { base, request } = await fixture(t, {
    configureTelegram: async () => { calls += 1; return { id: '123456789', firstName: 'Bot' }; },
  });
  const response = await request(base + '/api/telegram/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: '123456789:AA_this_is_a_test_bot_token_value', userId: '0' }),
  });
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test('Telegram setup and token verification require an authenticated browser session', async t => {
  const { base } = await fixture(t);
  for (const [path, body] of [
    ['/api/telegram/setup', { token: '123456789:AA_this_is_a_test_bot_token_value', userId: '42' }],
    ['/api/telegram/bot/verify', { token: '123456789:AA_this_is_a_test_bot_token_value' }],
  ]) {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 401);
  }
});

test('allowlist API preserves active state and added date and rejects disabling every user', async t => {
  const users = [
    { id: '123456789', comment: 'Основной', active: true, addedAt: '2026-11-26T10:00:00.000Z' },
    { id: '555123456', comment: 'Временно отключён', active: false, addedAt: '2026-11-25T10:00:00.000Z' },
  ];
  let saved = null;
  const { base, request } = await fixture(t, {
    getTelegramAllowlist: async () => ({ users }),
    setTelegramAllowlist: async next => { saved = next; return { users: next }; },
  });
  const read = await request(base + '/api/telegram/allowlist');
  assert.equal(read.status, 200);
  assert.deepEqual((await read.json()).users, users);

  const update = await request(base + '/api/telegram/allowlist', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ users }),
  });
  assert.equal(update.status, 200);
  assert.deepEqual(saved, users);

  const invalid = await request(base + '/api/telegram/allowlist', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ users: users.map(user => ({ ...user, active: false })) }),
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /хотя бы одного активного пользователя/);
});

test('allowlist API rejects invalid active flags and malformed added dates', async t => {
  const { base, request } = await fixture(t, {
    setTelegramAllowlist: async users => ({ users }),
  });
  for (const user of [
    { id: '123456789', active: 'false' },
    { id: '123456789', addedAt: 'not-a-date' },
  ]) {
    const response = await request(base + '/api/telegram/allowlist', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ users: [user] }),
    });
    assert.equal(response.status, 400);
  }
});
