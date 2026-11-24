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
