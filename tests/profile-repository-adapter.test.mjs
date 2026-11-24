import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfileRepositoryAdapter } from '../host/profile-repository-adapter.mjs';

function fakeClient({ profile = null, revision = 0 } = {}) {
  return {
    async readProfile() { return { profile, revision }; },
    async writeProfile(next, expected) {
      assert.equal(expected, revision);
      profile = next;
      return ++revision;
    },
    snapshot() { return { profile, revision }; },
  };
}

test('maps empty canonical profile to existing repository shape', async () => {
  const adapter = createProfileRepositoryAdapter(fakeClient());
  assert.deepEqual(await adapter.readProfile(), {
    state: undefined, logs: undefined, photos: undefined, revision: 0,
  });
});

test('round-trips profile fields and binary photo descriptors', async () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  const client = fakeClient();
  const adapter = createProfileRepositoryAdapter(client);
  const revision = await adapter.writeProfile(
    { tx: [{ id: 't1', amount: 42 }] },
    [{ action: 'created' }],
    { photo1: [{ __buildbookBlob: 1, type: 'image/jpeg', bytes: bytes.buffer }] },
    0,
  );
  assert.equal(revision, 1);
  const loaded = await adapter.readProfile();
  assert.deepEqual(loaded.state, { tx: [{ id: 't1', amount: 42 }] });
  assert.deepEqual(loaded.logs, [{ action: 'created' }]);
  const descriptor = loaded.photos.photo1[0];
  assert.equal(descriptor.__buildbookBlob, 1);
  assert.equal(descriptor.type, 'image/jpeg');
  assert.deepEqual(Array.from(new Uint8Array(descriptor.bytes)), [0, 1, 127, 128, 255]);
});

test('preserves typed-array byte range instead of serializing its entire backing buffer', async () => {
  const backing = new Uint8Array([9, 1, 2, 8]);
  const view = new Uint8Array(backing.buffer, 1, 2);
  const client = fakeClient();
  const adapter = createProfileRepositoryAdapter(client);
  await adapter.writeProfile({}, [], { image: view }, 0);
  const loaded = await adapter.readProfile();
  assert.deepEqual(Array.from(new Uint8Array(loaded.photos.image)), [1, 2]);
});

test('round-trips marker-shaped application data and own __proto__ keys safely', async () => {
  const markerCollision = JSON.parse('{"__buildbookBinaryV1":true,"encoding":"base64","data":"AQI="}');
  const escapedTagCollision = JSON.parse('{"__buildbookBinaryV1":true,"encoding":"escaped-object","entries":"ordinary user value"}');
  const protoKey = JSON.parse('{"__proto__":{"polluted":true}}');
  const client = fakeClient();
  const adapter = createProfileRepositoryAdapter(client);
  await adapter.writeProfile({ markerCollision, escapedTagCollision, protoKey }, [], {}, 0);
  const loaded = await adapter.readProfile();

  assert.deepEqual(loaded.state.markerCollision, markerCollision);
  assert.deepEqual(loaded.state.escapedTagCollision, escapedTagCollision);
  assert.deepEqual(loaded.state.protoKey, protoKey);
  assert.equal(Object.getPrototypeOf(loaded.state.protoKey), Object.prototype);
  assert.equal(Object.hasOwn(loaded.state.protoKey, '__proto__'), true);
  assert.equal(Object.prototype.polluted, undefined);
});

test('rejects duplicate keys in escaped transport objects', async () => {
  const profile = {
    state: {},
    logs: [],
    photos: {
      image: {
        __buildbookBinaryV1: true,
        encoding: 'escaped-object',
        entries: [['same', 1], ['same', 2]],
      },
    },
  };
  const adapter = createProfileRepositoryAdapter(fakeClient({ profile, revision: 1 }));
  await assert.rejects(adapter.readProfile(), /повторяющийся ключ экранированного объекта/);
});

test('rejects non-canonical base64 binary descriptors from the API', async () => {
  const profile = {
    state: {},
    logs: [],
    photos: { image: { __buildbookBinaryV1: true, encoding: 'base64', data: 'AQI' } },
  };
  const adapter = createProfileRepositoryAdapter(fakeClient({ profile, revision: 1 }));
  await assert.rejects(adapter.readProfile(), /некорректный бинарный дескриптор/);
});

test('rejects malformed adapter inputs and malformed canonical profile', async () => {
  assert.throws(() => createProfileRepositoryAdapter(null), /клиент/);
  const adapter = createProfileRepositoryAdapter(fakeClient({ profile: [] }));
  await assert.rejects(adapter.readProfile(), /некорректный ответ/);
});

test('refuses stale UI saves before writing and preserves host-owned metadata', async () => {
  let revision = 4;
  let writes = 0;
  const profile = {
    state: { tx: [{ id: 'existing' }] },
    logs: [],
    photos: {},
    telegram: { idempotency: { 'bot:1': 'op-1' } },
  };
  const client = {
    async readProfile() { return { profile, revision }; },
    async writeProfile(next, expectedRevision) {
      writes++;
      assert.equal(expectedRevision, revision);
      Object.assign(profile, next);
      return ++revision;
    },
  };
  const adapter = createProfileRepositoryAdapter(client);

  await assert.rejects(
    adapter.writeProfile({ tx: [{ id: 'stale-ui' }] }, [], {}, 3),
    error => error?.code === 'BUILD_BOOK_STORAGE_CONFLICT'
      && error.expectedRevision === 3
      && error.currentRevision === 4,
  );
  assert.equal(writes, 0);
  assert.deepEqual(profile.telegram.idempotency, { 'bot:1': 'op-1' });

  await adapter.writeProfile({ tx: [{ id: 'fresh-ui' }] }, [], {}, 4);
  assert.equal(writes, 1);
  assert.deepEqual(profile.telegram.idempotency, { 'bot:1': 'op-1' });
  assert.deepEqual(profile.state, { tx: [{ id: 'fresh-ui' }] });
});


test('rejects malformed canonical read responses and invalid next revisions', async () => {
  const malformedRead = createProfileRepositoryAdapter({
    async readProfile() { return { profile: null, revision: -1 }; },
    async writeProfile() { return 1; },
  });
  await assert.rejects(malformedRead.readProfile(), /некорректный ответ/);

  const malformedProfile = createProfileRepositoryAdapter({
    async readProfile() { return { profile: [], revision: 0 }; },
    async writeProfile() { return 1; },
  });
  await assert.rejects(malformedProfile.writeProfile({}, [], {}, 0), /некорректный ответ/);

  const badRevision = createProfileRepositoryAdapter({
    async readProfile() { return { profile: null, revision: 0 }; },
    async writeProfile() { return 2; },
  });
  await assert.rejects(
    badRevision.writeProfile({}, [], {}, 0),
    /некорректную ревизию после сохранения/,
  );
});

test('rejects exhausted revision before contacting the canonical API', async () => {
  let calls = 0;
  const adapter = createProfileRepositoryAdapter({
    async readProfile() { calls++; return { profile: null, revision: Number.MAX_SAFE_INTEGER }; },
    async writeProfile() { calls++; return Number.MAX_SAFE_INTEGER; },
  });
  await assert.rejects(
    adapter.writeProfile({}, [], {}, Number.MAX_SAFE_INTEGER),
    /корректн.*ревизи/,
  );
  assert.equal(calls, 0);
});


test('rejects 20 malformed canonical profile shapes before exposing data or writing', async t => {
  const malformed = [
    [],
    'profile',
    0,
    { logs: [], photos: {} },
    { state: {}, photos: {} },
    { state: {}, logs: [] },
    { state: null, logs: [], photos: {} },
    { state: [], logs: [], photos: {} },
    { state: 'state', logs: [], photos: {} },
    { state: {}, logs: {}, photos: {} },
    { state: {}, logs: 'logs', photos: {} },
    { state: {}, logs: [], photos: [] },
    { state: {}, logs: [], photos: null },
    { state: {}, logs: [], photos: 'photos' },
    { state: {}, logs: [], photos: {}, version: 'bad', extra: true },
    { state: {}, logs: {}, photos: [] },
    { state: false, logs: false, photos: false },
    { state: {}, logs: [], photos: {}, revision: -1 },
    { state: {}, logs: [], photos: {}, schema: [] },
  ];
  for (const [index, profile] of malformed.entries()) {
    await t.test('shape ' + (index + 1), async () => {
      const adapter = createProfileRepositoryAdapter({
        async readProfile() { return { profile, revision: 1 }; },
        async writeProfile() { throw new Error('write must not be called'); },
      });
      await assert.rejects(adapter.readProfile(), /некорректный ответ|неверный формат/);
      await assert.rejects(adapter.writeProfile({}, [], {}, 1), /некорректный ответ/);
    });
  }
});

test('preserves extra host metadata while enforcing canonical core fields', async () => {
  let stored = {
    state: { tx: [] }, logs: [], photos: {},
    telegram: { idempotency: { 'bot:42': 'operation-42' } },
    hostMetadata: { version: 3 },
  };
  let revision = 7;
  const adapter = createProfileRepositoryAdapter({
    async readProfile() { return { profile: stored, revision }; },
    async writeProfile(profile, expectedRevision) {
      assert.equal(expectedRevision, revision);
      stored = profile;
      return ++revision;
    },
  });
  await adapter.writeProfile({ tx: [{ id: 'ui-update' }] }, [], {}, 7);
  const loaded = await adapter.readProfile();
  assert.deepEqual(loaded.state, { tx: [{ id: 'ui-update' }] });
  assert.deepEqual(stored.telegram, { idempotency: { 'bot:42': 'operation-42' } });
  assert.deepEqual(stored.hostMetadata, { version: 3 });
});


test('does not retry a write that races after the adapter preflight read', async t => {
  for (let currentRevision = 2; currentRevision <= 21; currentRevision += 1) {
    await t.test('raced revision ' + currentRevision, async () => {
      let reads = 0;
      let writes = 0;
      const adapter = createProfileRepositoryAdapter({
        async readProfile() {
          reads += 1;
          return {
            revision: 1,
            profile: { state: { tx: [] }, logs: [], photos: {} },
          };
        },
        async writeProfile(_profile, expectedRevision) {
          writes += 1;
          assert.equal(expectedRevision, 1);
          const error = new Error('another client committed');
          error.code = 'BUILD_BOOK_STORAGE_CONFLICT';
          error.expectedRevision = expectedRevision;
          error.currentRevision = currentRevision;
          throw error;
        },
      });
      await assert.rejects(adapter.writeProfile({ tx: [{ id: 'local' }] }, [], {}, 1), error => {
        assert.equal(error.code, 'BUILD_BOOK_STORAGE_CONFLICT');
        assert.equal(error.expectedRevision, 1);
        assert.equal(error.currentRevision, currentRevision);
        return true;
      });
      assert.equal(reads, 1, 'adapter must not silently reload and replay stale UI state');
      assert.equal(writes, 1, 'adapter must not retry a conflicting financial write');
    });
  }
});
