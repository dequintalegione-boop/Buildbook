import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalProfileClient } from '../host/local-profile-client.mjs';

const token = 'test-local-api-token-0123456789abcdef';
function fakeFetch(handler) {
  return async (url, options = {}) => {
    const result = await handler(url, options);
    return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.body };
  };
}

test('requires a sufficiently long API token', () => {
  assert.throws(() => createLocalProfileClient({ accessToken: 'short' }), /API-токен/);
});

test('rejects non-loopback API URLs before any request can expose the bearer token', async () => {
  for (const baseUrl of [
    'https://example.com',
    'http://192.168.1.20:43127',
    'http://user:pass@localhost:43127',
    'http://localhost:43127/proxy',
    'http://localhost:43127/?redirect=1',
  ]) {
    let requested = false;
    assert.throws(() => createLocalProfileClient({
      baseUrl,
      accessToken: token,
      fetchImpl: async () => { requested = true; },
    }), /только по HTTP на localhost/);
    assert.equal(requested, false);
  }
});

test('allows explicit loopback hosts and preserves a configured port', async () => {
  for (const baseUrl of ['http://localhost:43128', 'http://127.0.0.1:43129', 'http://[::1]:43130']) {
    const client = createLocalProfileClient({
      baseUrl,
      accessToken: token,
      fetchImpl: fakeFetch(async (url) => {
        assert.equal(url, baseUrl + '/api/health');
        return { status: 200, body: { ok: true } };
      }),
    });
    assert.deepEqual(await client.health(), { ok: true });
  }
});

test('exchanges the bootstrap token once and uses only a browser-managed session afterwards', async () => {
  const calls = [];
  const client = createLocalProfileClient({
    accessToken: token,
    fetchImpl: fakeFetch(async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/api/session/bootstrap')) return { status: 200, body: { ok: true, expiresIn: 12 * 60 * 60 * 1000 } };
      if (url.endsWith('/api/health')) return { status: 200, body: { ok: true } };
      if (url.endsWith('/api/session/close')) return { status: 200, body: { ok: true } };
      throw new Error('unexpected request');
    }),
  });
  assert.equal(await client.connectSession(), true);
  assert.equal(client.connected, true);
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.headers.authorization, 'Bearer ' + token);
  await client.health();
  assert.equal(calls[1].options.credentials, 'include');
  assert.equal(calls[1].options.headers.authorization, undefined);
  await client.closeSession();
  assert.equal(client.connected, false);
  await assert.rejects(client.connectSession(), /создайте новый клиент/);
});

test('disables redirects, ambient credentials, caching and referrer on token requests', async () => {
  const client = createLocalProfileClient({
    accessToken: token,
    fetchImpl: fakeFetch(async (_url, options) => {
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.referrerPolicy, 'no-referrer');
      return { status: 200, body: { ok: true } };
    }),
  });
  await client.health();
});

test('maps redirect refusal to the safe unavailable error without retrying elsewhere', async () => {
  let calls = 0;
  const client = createLocalProfileClient({
    accessToken: token,
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.redirect, 'error');
      throw new Error('redirect blocked');
    },
  });
  await assert.rejects(client.health(), error => error.code === 'BUILD_BOOK_LOCAL_API_UNAVAILABLE');
  assert.equal(calls, 1);
});

test('rejects API tokens longer than the server limit before making a request', () => {
  assert.throws(() => createLocalProfileClient({
    accessToken: 'x'.repeat(4097),
    fetchImpl: async () => { throw new Error('must not be called'); },
  }), /32 до 4096 байт/);
});

test('reads profile and sends bearer token to local API', async () => {
  const client = createLocalProfileClient({
    accessToken: token,
    fetchImpl: fakeFetch(async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:43127/api/profile');
      assert.equal(options.headers.authorization, 'Bearer ' + token);
      return { status: 200, body: { revision: 4, profile: { state: { tx: [] } } } };
    }),
  });
  assert.deepEqual(await client.readProfile(), { revision: 4, profile: { state: { tx: [] } } });
});

test('rejects invalid or oversized profiles before sending a request', async () => {
  let calls = 0;
  const client = createLocalProfileClient({
    accessToken: token,
    fetchImpl: async () => { calls += 1; throw new Error('must not be called'); },
  });
  await assert.rejects(client.writeProfile([], 0), /должен быть объектом/);
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(client.writeProfile(cyclic, 0), /сериализуемые JSON-данные/);
  await assert.rejects(client.writeProfile({ payload: 'x'.repeat(8 * 1024 * 1024) }, 0), /8 MiB/);
  assert.equal(calls, 0);
});

test('posts a transfer envelope with the target revision and validates the import result', async () => {
  const envelope = {
    format: 'buildbook-profile-export',
    version: 1,
    sourceSchemaVersion: 5,
    exportedAt: '2026-11-23T10:00:00.000Z',
    payload: { state: {}, logs: [], photos: {} },
    sha256: 'a'.repeat(64),
  };
  const client = createLocalProfileClient({
    accessToken: token,
    fetchImpl: fakeFetch(async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:43127/api/profile/import');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { envelope, expectedRevision: 0 });
      return { status: 200, body: { revision: 1, imported: true } };
    }),
  });
  assert.equal(await client.importProfile(envelope, 0), 1);
});

test('rejects malformed import results and oversized transfer requests', async () => {
  const client = createLocalProfileClient({
    accessToken: token,
    fetchImpl: fakeFetch(async () => ({ status: 200, body: { revision: 1, imported: false } })),
  });
  await assert.rejects(client.importProfile({}, 0), /некорректный результат импорта/);
  let calls = 0;
  const limited = createLocalProfileClient({
    accessToken: token,
    fetchImpl: async () => { calls += 1; throw new Error('must not be called'); },
  });
  await assert.rejects(limited.importProfile({ payload: { huge: 'x'.repeat(34 * 1024 * 1024) } }, 0), /34 MiB/);
  assert.equal(calls, 0);
});

test('writes with optimistic revision and returns next revision', async () => {
  const client = createLocalProfileClient({
    accessToken: token,
    fetchImpl: fakeFetch(async (_url, options) => {
      assert.equal(options.method, 'PUT');
      assert.deepEqual(JSON.parse(options.body), { profile: { marker: 'new' }, expectedRevision: 8 });
      return { status: 200, body: { revision: 9 } };
    }),
  });
  assert.equal(await client.writeProfile({ marker: 'new' }, 8), 9);
});

test('rejects exhausted revisions before profile writes or imports', async () => {
  let calls = 0;
  const client = createLocalProfileClient({
    accessToken: token,
    fetchImpl: async () => { calls += 1; throw new Error('must not be called'); },
  });
  await assert.rejects(client.writeProfile({ marker: true }, Number.MAX_SAFE_INTEGER), /корректн.*ревизи/);
  await assert.rejects(client.importProfile({ marker: true }, Number.MAX_SAFE_INTEGER), /корректн.*ревизи/);
  assert.equal(calls, 0);
});

test('preserves revision conflicts as typed errors', async () => {
  const client = createLocalProfileClient({
    accessToken: token,
    fetchImpl: fakeFetch(async () => ({
      status: 409,
      body: { code: 'BUILD_BOOK_STORAGE_CONFLICT', error: 'stale revision' },
    })),
  });
  await assert.rejects(client.writeProfile({}, 0), error =>
    error.status === 409 && error.code === 'BUILD_BOOK_STORAGE_CONFLICT' && /stale revision/.test(error.message));
});

test('maps network failures to a stable unavailable error', async () => {
  const client = createLocalProfileClient({ accessToken: token, fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(client.health(), error => error.code === 'BUILD_BOOK_LOCAL_API_UNAVAILABLE');
});

test('rejects malformed profile responses', async () => {
  const client = createLocalProfileClient({
    accessToken: token,
    fetchImpl: fakeFetch(async () => ({ status: 200, body: { revision: -1, profile: [] } })),
  });
  await assert.rejects(client.readProfile(), /некорректный профиль/);
});

test('bounds request time and reports timeout distinctly', async () => {
  const client = createLocalProfileClient({
    accessToken: token,
    requestTimeoutMs: 5,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });
  await assert.rejects(client.health(), error =>
    error.code === 'BUILD_BOOK_LOCAL_API_TIMEOUT' && /не ответил за отведённое время/.test(error.message));
});

test('rejects invalid request timeout configuration', () => {
  for (const requestTimeoutMs of [0, -1, 1.5, 120001, NaN]) {
    assert.throws(() => createLocalProfileClient({ accessToken: token, requestTimeoutMs }), /Тайм-аут локального API/);
  }
});

test('keeps the timeout active while reading the response body', async () => {
  const client = createLocalProfileClient({
    accessToken: token,
    requestTimeoutMs: 5,
    fetchImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }),
    }),
  });
  await assert.rejects(client.health(), error => error.code === 'BUILD_BOOK_LOCAL_API_TIMEOUT');
});
