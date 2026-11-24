import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanonicalProfileRuntime } from '../client/canonical-profile-runtime.mjs';

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload; } };
}

test('canonical runtime only accepts loopback HTTP origins', () => {
  for (const baseUrl of [
    'https://127.0.0.1:43127',
    'http://example.com',
    'http://127.0.0.1:43127/path',
    'http://user:pass@localhost:43127',
    'http://localhost:43127?token=x',
  ]) {
    assert.throws(() => createCanonicalProfileRuntime({ baseUrl, fetchImpl: async () => jsonResponse({}) }));
  }
});

test('canonical runtime uses the existing HttpOnly session and never sends bearer credentials', async () => {
  const calls = [];
  const runtime = createCanonicalProfileRuntime({
    baseUrl: 'http://localhost:43127',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ revision: 0, profile: null });
    },
  });
  assert.equal(await runtime.verifySession(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://localhost:43127/api/profile');
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.referrerPolicy, 'no-referrer');
  assert.equal('authorization' in calls[0].options.headers, false);
});

test('repository adapter reads and writes canonical state with revision protection', async () => {
  let profile = null;
  let revision = 0;
  const runtime = createCanonicalProfileRuntime({
    fetchImpl: async (url, options) => {
      if (url.endsWith('/api/profile') && options.method === 'PUT') {
        const body = JSON.parse(options.body);
        if (body.expectedRevision !== revision) return jsonResponse({ code: 'BUILD_BOOK_STORAGE_CONFLICT', error: 'stale' }, 409);
        profile = body.profile;
        revision += 1;
        return jsonResponse({ revision });
      }
      return jsonResponse({ revision, profile });
    },
  });

  const initial = await runtime.repository.readProfile();
  assert.equal(initial.revision, 0);
  assert.equal(initial.state, undefined);
  const next = await runtime.repository.writeProfile({ tx: [{ id: 'tx-1', sum: 25 }] }, [], {}, initial.revision);
  assert.equal(next, 1);
  const saved = await runtime.repository.readProfile();
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.state.tx, [{ id: 'tx-1', sum: 25 }]);
});

test('canonical runtime preserves unauthorized and revision-conflict errors', async () => {
  const unauthorized = createCanonicalProfileRuntime({
    fetchImpl: async () => jsonResponse({ error: 'session expired' }, 401),
  });
  await assert.rejects(unauthorized.client.readProfile(), error => error.code === 'BUILD_BOOK_LOCAL_API_UNAUTHORIZED');

  const conflict = createCanonicalProfileRuntime({
    fetchImpl: async () => jsonResponse({ code: 'BUILD_BOOK_STORAGE_CONFLICT', error: 'stale' }, 409),
  });
  await assert.rejects(conflict.client.readProfile(), error => error.code === 'BUILD_BOOK_STORAGE_CONFLICT');
});

test('canonical runtime does not silently fall back when the API is unavailable', async () => {
  const runtime = createCanonicalProfileRuntime({
    fetchImpl: async () => { throw new Error('offline'); },
  });
  await assert.rejects(runtime.repository.readProfile(), error => error.code === 'BUILD_BOOK_LOCAL_API_UNAVAILABLE');
});

test('canonical runtime validates timeout and profile writes', async () => {
  assert.throws(() => createCanonicalProfileRuntime({ requestTimeoutMs: 0 }));
  const runtime = createCanonicalProfileRuntime({ fetchImpl: async () => jsonResponse({ revision: 1 }) });
  await assert.rejects(runtime.client.writeProfile([], 0), TypeError);
  await assert.rejects(runtime.client.writeProfile({}, -1), TypeError);
});

test('canonical runtime keeps its timeout active until the response body is read', async () => {
  const runtime = createCanonicalProfileRuntime({
    requestTimeoutMs: 10,
    fetchImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      json() {
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      },
    }),
  });
  await assert.rejects(
    runtime.client.readProfile(),
    error => error.code === 'BUILD_BOOK_LOCAL_API_TIMEOUT',
  );
});


test('classifies 20 uncertain save responses and requires a fresh profile read', async t => {
  const cases = [
    ...[500, 501, 502, 503, 504, 505, 507, 599].map(status => ({ label: 'server error ' + status, status, payload: { error: 'commit response interrupted' } })),
    ...[null, {}, { revision: 0 }, { revision: -1 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER },
      { revision: '1' }, { revision: 2 }, { revision: 1, extra: true },
      { revision: undefined }, { revision: null }, { revision: [] }].map((payload, index) => ({ label: 'invalid success ' + (index + 1), status: 200, payload })),
  ];
  for (const scenario of cases) {
    await t.test(scenario.label, async () => {
      const runtime = createCanonicalProfileRuntime({
        fetchImpl: async () => jsonResponse(scenario.payload, scenario.status),
      });
      await assert.rejects(runtime.client.writeProfile({ marker: true }, 0), error =>
        error.code === 'BUILD_BOOK_SAVE_RESULT_UNKNOWN'
        && /перечитайте профиль/.test(error.message));
    });
  }
});


test('preserves valid conflict revision metadata and ignores malformed values', async t => {
  const cases = [
    { expectedRevision: 0, currentRevision: 1 },
    { expectedRevision: 1, currentRevision: 2 },
    { expectedRevision: 2, currentRevision: 9 },
    { expectedRevision: 10, currentRevision: 11 },
    { expectedRevision: 99, currentRevision: 100 },
    { expectedRevision: 0, currentRevision: 900 },
    { expectedRevision: 900, currentRevision: 901 },
    { expectedRevision: 1, currentRevision: 9007199254740991 },
    { expectedRevision: 42, currentRevision: 43 },
    { expectedRevision: 123456, currentRevision: 123457 },
    { expectedRevision: -1, currentRevision: 1 },
    { expectedRevision: 1, currentRevision: -1 },
    { expectedRevision: 1.5, currentRevision: 2 },
    { expectedRevision: 1, currentRevision: 2.5 },
    { expectedRevision: '1', currentRevision: '2' },
    { expectedRevision: null, currentRevision: 1 },
    { expectedRevision: 1, currentRevision: null },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1, currentRevision: 1 },
    { expectedRevision: 1, currentRevision: Number.MAX_SAFE_INTEGER + 1 },
    { expectedRevision: {}, currentRevision: [] },
  ];
  for (const [index, metadata] of cases.entries()) {
    await t.test('conflict metadata ' + (index + 1), async () => {
      const client = createCanonicalProfileRuntime({ fetchImpl: async () => jsonResponse({ code: 'BUILD_BOOK_STORAGE_CONFLICT', error: 'stale', ...metadata }, 409) }).client;
      await assert.rejects(client.readProfile(), error => {
        assert.equal(error.code, 'BUILD_BOOK_STORAGE_CONFLICT');
        assert.equal(error.expectedRevision, Number.isSafeInteger(metadata.expectedRevision) && metadata.expectedRevision >= 0 ? metadata.expectedRevision : undefined);
        assert.equal(error.currentRevision, Number.isSafeInteger(metadata.currentRevision) && metadata.currentRevision >= 0 ? metadata.currentRevision : undefined);
        return true;
      });
    });
  }
});


test('canonical runtime deadline settles even when fetch ignores abort', async () => {
  const runtime = createCanonicalProfileRuntime({
    requestTimeoutMs: 10,
    fetchImpl: async () => new Promise(() => {}),
  });
  await assert.rejects(
    runtime.client.readProfile(),
    error => error.code === 'BUILD_BOOK_LOCAL_API_TIMEOUT',
  );
});


test('canonical runtime rejects malformed save acknowledgements', async t => {
  const replies = [
    { revision: 1, extra: true },
    { revision: Number.MAX_SAFE_INTEGER },
    { revision: '1' },
    { revision: 0 },
    null,
    [],
  ];
  for (const [index, payload] of replies.entries()) {
    await t.test('invalid acknowledgement ' + (index + 1), async () => {
      const runtime = createCanonicalProfileRuntime({
        fetchImpl: async () => jsonResponse(payload),
      });
      await assert.rejects(
        runtime.client.writeProfile({ marker: true }, 0),
        error => error.code === 'BUILD_BOOK_SAVE_RESULT_UNKNOWN',
      );
    });
  }
});
