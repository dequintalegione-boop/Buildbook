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
      return { status: 200, body: { revision: 1, imported: true, verified: true } };
    }),
  });
  assert.equal(await client.importProfile(envelope, 0), 1);
});

test('rejects malformed or unverified import results and oversized transfer requests', async () => {
  for (const body of [
    { revision: 1, imported: false, verified: true },
    { revision: 1, imported: true, verified: false },
    { revision: 1, imported: true },
    { revision: 2, imported: true, verified: true },
    { revision: -1, imported: true, verified: true },
    { revision: 1.5, imported: true, verified: true },
    null,
    [],
    {},
  ]) {
    const client = createLocalProfileClient({
      accessToken: token,
      fetchImpl: fakeFetch(async () => ({ status: 200, body })),
    });
    await assert.rejects(client.importProfile({ payload: {} }, 0), /некорректный результат импорта/);
  }
  const client = createLocalProfileClient({
    accessToken: token,
    fetchImpl: fakeFetch(async () => ({ status: 200, body: { revision: 1, imported: false, verified: false } })),
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


test('enforces the request deadline across 20 stalled response-body variants', async t => {
  const stalls = [
    'health', 'profile', 'telegram status', 'session bootstrap', 'session close',
    'profile import', 'profile write', 'empty body', 'slow JSON parser', 'unreadable body',
    'chunked response', 'truncated response', 'body stream stalled', 'body parser pending',
    'server flush stalled', 'headers then stall', 'body after headers', 'response decode stall',
    'large body stall', 'final chunk missing',
  ];
  for (const [index, label] of stalls.entries()) {
    await t.test(label, async () => {
      const client = createLocalProfileClient({
        accessToken: token,
        requestTimeoutMs: 5,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: () => new Promise(() => {}),
        }),
      });
      await assert.rejects(client.health(), error =>
        error.code === 'BUILD_BOOK_LOCAL_API_TIMEOUT'
        && /не ответил за отведённое время/.test(error.message),
      );
    });
  }
});


test('coalesces 20 concurrent connect and close bursts into one session transition', async t => {
  for (let burst = 2; burst <= 21; burst += 1) {
    await t.test('concurrent callers: ' + burst, async () => {
      let bootstrapCalls = 0;
      let closeCalls = 0;
      const client = createLocalProfileClient({
        accessToken: token,
        fetchImpl: fakeFetch(async url => {
          if (url.endsWith('/api/session/bootstrap')) {
            bootstrapCalls += 1;
            await Promise.resolve();
            return { status: 200, body: { ok: true, expiresIn: 12 * 60 * 60 * 1000 } };
          }
          if (url.endsWith('/api/session/close')) {
            closeCalls += 1;
            await Promise.resolve();
            return { status: 200, body: { ok: true } };
          }
          throw new Error('unexpected request');
        }),
      });

      const connects = await Promise.all(Array.from({ length: burst }, () => client.connectSession()));
      assert.ok(connects.every(value => value === true));
      assert.equal(bootstrapCalls, 1, 'one bootstrap should create exactly one server session');

      const closes = await Promise.all(Array.from({ length: burst }, () => client.closeSession()));
      assert.equal(closes.filter(Boolean).length, 1, 'only one caller performs the close transition');
      assert.equal(closeCalls, 1, 'one close request should revoke the session once');
      assert.equal(client.connected, false);
    });
  }
});


test('allows safe retry after 20 failed session transition responses', async t => {
  const variants = [
    ['bootstrap', 400], ['bootstrap', 401], ['bootstrap', 403], ['bootstrap', 408], ['bootstrap', 429],
    ['bootstrap', 500], ['bootstrap', 502], ['bootstrap', 503], ['bootstrap', 504], ['bootstrap', 599],
    ['close', 400], ['close', 401], ['close', 403], ['close', 408], ['close', 429],
    ['close', 500], ['close', 502], ['close', 503], ['close', 504], ['close', 599],
  ];
  for (const [operation, status] of variants) {
    await t.test(operation + ' HTTP ' + status, async () => {
      let failed = false;
      let bootstrapCalls = 0;
      let closeCalls = 0;
      const client = createLocalProfileClient({
        accessToken: token,
        fetchImpl: fakeFetch(async url => {
          if (url.endsWith('/api/session/bootstrap')) {
            bootstrapCalls += 1;
            if (operation === 'bootstrap' && !failed) {
              failed = true;
              return { status, body: { error: 'temporary failure' } };
            }
            return { status: 200, body: { ok: true, expiresIn: 12 * 60 * 60 * 1000 } };
          }
          if (url.endsWith('/api/session/close')) {
            closeCalls += 1;
            if (operation === 'close' && !failed) {
              failed = true;
              return { status, body: { error: 'temporary failure' } };
            }
            return { status: 200, body: { ok: true } };
          }
          throw new Error('unexpected request');
        }),
      });

      if (operation === 'close') await client.connectSession();
      await assert.rejects(
        operation === 'bootstrap' ? client.connectSession() : client.closeSession(),
        error => error.status === status,
      );
      if (operation === 'bootstrap') {
        assert.equal(client.connected, false);
        assert.equal(await client.connectSession(), true);
        assert.equal(bootstrapCalls, 2);
      } else {
        assert.equal(client.connected, true, 'failed close must preserve local connected state');
        assert.equal(await client.closeSession(), true);
        assert.equal(closeCalls, 2);
        assert.equal(client.connected, false);
      }
    });
  }
});


test('marks 20 ambiguous write outcomes so callers reread instead of blindly retrying', async t => {
  const cases = [
    ...[400, 408, 429, 500, 502, 503, 504, 599].map(status => ({ label: 'HTTP ' + status, status, body: { error: 'response lost near commit' } })),
    ...[null, {}, { revision: 0 }, { revision: -1 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER },
      { revision: '1' }, { revision: 2 }, { revision: 1, extra: 'bad' },
      { revision: undefined }, { revision: null }, { revision: [] }].map((body, index) => ({ label: 'malformed success ' + (index + 1), status: 200, body })),
  ];
  for (const [index, scenario] of cases.entries()) {
    await t.test(scenario.label, async () => {
      const client = createLocalProfileClient({
        accessToken: token,
        fetchImpl: async () => {
          if (scenario.status === undefined) throw new Error('network unavailable');
          return {
            ok: scenario.status >= 200 && scenario.status < 300,
            status: scenario.status,
            json: async () => scenario.body,
          };
        },
      });
      await assert.rejects(client.writeProfile({ marker: index }, 0), error =>
        error.code === 'BUILD_BOOK_SAVE_RESULT_UNKNOWN'
        && /перечитайте профиль/.test(error.message));
    });
  }
});
