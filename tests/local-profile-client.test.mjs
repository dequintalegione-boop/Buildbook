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
