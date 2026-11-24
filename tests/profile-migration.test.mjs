import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateProfileToLocalApi } from '../host/profile-migration.mjs';

function fixture(source, targetProfile = null) {
  let stored = targetProfile;
  let revision = targetProfile === null ? 0 : 1;
  const client = {
    async readProfile() { return { revision, profile: stored }; },
    async importProfile(envelope, expectedRevision) {
      assert.equal(expectedRevision, revision);
      if (stored !== null) throw new Error('target not empty');
      stored = envelope.payload;
      revision += 1;
      return revision;
    },
  };
  const createEnvelope = async payload => ({
    format: 'buildbook-profile-export',
    version: 1,
    sourceSchemaVersion: 5,
    exportedAt: '2026-11-24T00:00:00.000Z',
    payload,
    sha256: 'a'.repeat(64),
  });
  return { client, sourceProfile: source, createEnvelope, readStored: () => stored, readRevision: () => revision };
}

test('copies IndexedDB snapshot into an empty canonical profile and verifies it', async () => {
  const sourceProfile = {
    state: { schemaVersion: 5, tx: [{ id: 'tx-1', amount: 1250 }] },
    logs: [{ id: 'log-1' }],
    photos: { build1: ['data:image/jpeg;base64,AA=='] },
    revision: 17,
    internalMetadata: { mustNotTransfer: true },
  };
  const data = fixture(sourceProfile);
  const result = await migrateProfileToLocalApi(data);
  assert.deepEqual(result, { migrated: true, revision: 1, verified: true });
  assert.deepEqual(data.readStored(), {
    state: sourceProfile.state,
    logs: sourceProfile.logs,
    photos: sourceProfile.photos,
  });
  assert.equal(data.readRevision(), 1);
  assert.equal(sourceProfile.internalMetadata.mustNotTransfer, true);
});

test('never overwrites an existing canonical profile', async () => {
  const existing = { marker: 'canonical-data' };
  const data = fixture({
    state: {}, logs: [], photos: {},
  }, existing);
  await assert.rejects(migrateProfileToLocalApi(data), error =>
    error.code === 'BUILD_BOOK_MIGRATION_TARGET_NOT_EMPTY');
  assert.deepEqual(data.readStored(), existing);
  assert.equal(data.readRevision(), 1);
});

test('rejects invalid source and mismatched export envelope before import', async () => {
  const data = fixture({ state: {}, logs: [], photos: {} });
  await assert.rejects(migrateProfileToLocalApi({ ...data, sourceProfile: { state: [], logs: [], photos: {} } }), /неподдерживаемый формат/);
  const mismatch = { ...data, createEnvelope: async () => ({
    payload: { state: {}, logs: [], photos: { altered: true } },
  }) };
  await assert.rejects(migrateProfileToLocalApi(mismatch), /не совпадает с исходным снимком/);
  assert.equal(data.readStored(), null);
  assert.equal(data.readRevision(), 0);
});

test('refuses to report migration success when verification differs from the imported snapshot', async () => {
  const sourceProfile = { state: { marker: 'source' }, logs: [], photos: {} };
  const data = fixture(sourceProfile);
  const originalRead = data.client.readProfile;
  let reads = 0;
  data.client.readProfile = async () => {
    reads += 1;
    if (reads === 1) return originalRead();
    return { revision: 1, profile: { state: { marker: 'different' }, logs: [], photos: {} } };
  };
  await assert.rejects(migrateProfileToLocalApi(data), error =>
    error.code === 'BUILD_BOOK_MIGRATION_VERIFY_FAILED');
  assert.deepEqual(sourceProfile, { state: { marker: 'source' }, logs: [], photos: {} });
});

test('keeps the source untouched if the target revision changes before import', async () => {
  const sourceProfile = { state: { tx: [] }, logs: [], photos: {} };
  const data = fixture(sourceProfile);
  const originalImport = data.client.importProfile;
  data.client.importProfile = async () => {
    throw Object.assign(new Error('stale target'), { code: 'BUILD_BOOK_STORAGE_CONFLICT' });
  };
  await assert.rejects(migrateProfileToLocalApi(data), error => error.code === 'BUILD_BOOK_STORAGE_CONFLICT');
  assert.equal(data.readStored(), null);
  assert.deepEqual(sourceProfile, { state: { tx: [] }, logs: [], photos: {} });
  data.client.importProfile = originalImport;
});
