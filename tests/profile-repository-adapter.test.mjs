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

test('rejects malformed adapter inputs and malformed canonical profile', async () => {
  assert.throws(() => createProfileRepositoryAdapter(null), /клиент/);
  const adapter = createProfileRepositoryAdapter(fakeClient({ profile: [] }));
  await assert.rejects(adapter.readProfile(), /неверный формат/);
});
