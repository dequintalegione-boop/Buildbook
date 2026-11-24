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
  await assert.rejects(migrateProfileToLocalApi(mismatch), /не совпадает с исходным снимком/i);
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


test('rejects 20 malformed migration inputs and target states before unsafe import', async t => {
  const validSource = { state: { tx: [] }, logs: [], photos: {} };
  const validEnvelope = payload => ({
    format: 'buildbook-profile-export',
    version: 1,
    sourceSchemaVersion: 5,
    exportedAt: '2026-11-24T00:00:00.000Z',
    payload,
    sha256: 'a'.repeat(64),
  });
  const cases = [
    ['missing client', { client: null }],
    ['missing profile reader', { client: { importProfile: async () => 1 } }],
    ['missing profile importer', { client: { readProfile: async () => ({ revision: 0, profile: null }) } }],
    ['missing envelope factory', { createEnvelope: null }],
    ['null source', { sourceProfile: null }],
    ['array source', { sourceProfile: [] }],
    ['missing source state', { sourceProfile: { logs: [], photos: {} } }],
    ['array source state', { sourceProfile: { state: [], logs: [], photos: {} } }],
    ['missing source logs', { sourceProfile: { state: {}, photos: {} } }],
    ['object source logs', { sourceProfile: { state: {}, logs: {}, photos: {} } }],
    ['missing source photos', { sourceProfile: { state: {}, logs: [] } }],
    ['array source photos', { sourceProfile: { state: {}, logs: [], photos: [] } }],
    ['negative target revision', { target: { revision: -1, profile: null } }],
    ['fractional target revision', { target: { revision: 0.5, profile: null } }],
    ['missing target revision', { target: { profile: null } }],
    ['array target profile', { target: { revision: 0, profile: [] } }],
    ['target profile already populated', { target: { revision: 2, profile: { state: {} } } }],
    ['null envelope', { envelope: null }],
    ['array envelope payload', { envelope: { payload: [] } }],
    ['payload differs from source snapshot', { envelope: { payload: { state: {}, logs: [], photos: { altered: true } } } }],
  ];

  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const data = fixture(validSource);
      let importCalls = 0;
      data.client.importProfile = async () => { importCalls += 1; return 1; };
      if (options.target) data.client.readProfile = async () => options.target;
      if (options.client !== undefined) data.client = options.client;
      if (options.createEnvelope !== undefined) data.createEnvelope = options.createEnvelope;
      if (options.sourceProfile !== undefined) data.sourceProfile = options.sourceProfile;
      if (name === 'null envelope') data.createEnvelope = async () => null;
      else if (options.envelope !== undefined) data.createEnvelope = async payload => ({
        ...validEnvelope(payload),
        ...options.envelope,
      });

      await assert.rejects(migrateProfileToLocalApi(data));
      assert.equal(importCalls, 0, 'unsafe input must not reach the import call');
    });
  }
});


test('keeps the migration snapshot stable across 20 concurrent source edits', async t => {
  const mutations = [
    ['change a top-level state field', source => { source.state.marker = 'edited'; }],
    ['append a transaction', source => { source.state.tx.push({ id: 'late', amount: 99 }); }],
    ['edit a nested transaction', source => { source.state.tx[0].amount = 99; }],
    ['replace the state object', source => { source.state = { replaced: true }; }],
    ['replace the transaction list', source => { source.state.tx = []; }],
    ['append a log entry', source => { source.logs.push({ id: 'late' }); }],
    ['edit a nested log', source => { source.logs[0].message = 'edited'; }],
    ['replace the logs array', source => { source.logs = []; }],
    ['add a photo', source => { source.photos.newBuild = ['photo-b']; }],
    ['append to a photo list', source => { source.photos.build.push('photo-b'); }],
    ['replace a photo list', source => { source.photos.build = ['replacement']; }],
    ['replace the photos object', source => { source.photos = { replacement: [] }; }],
    ['replace the whole source state', source => { source.state = { tx: [{ id: 'late' }] }; }],
    ['delete a transaction', source => { source.state.tx.pop(); }],
    ['delete a log', source => { source.logs.pop(); }],
    ['delete a photo collection', source => { delete source.photos.build; }],
    ['add IndexedDB revision metadata', source => { source.revision = 77; }],
    ['add host-owned metadata', source => { source.internalMetadata = { secret: true }; }],
    ['mutate a nested transaction field', source => { source.state.tx[0].id = 'changed'; }],
    ['mutate the original source after replacing logs', source => { source.logs = [{ id: 'replacement' }]; }],
  ];

  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const sourceProfile = {
        state: { marker: 'initial', tx: [{ id: 'tx-1', amount: 1 }] },
        logs: [{ id: 'log-1', message: 'initial' }],
        photos: { build: ['photo-a'] },
      };
      const expected = JSON.parse(JSON.stringify({
        state: sourceProfile.state,
        logs: sourceProfile.logs,
        photos: sourceProfile.photos,
      }));
      const data = fixture(sourceProfile);
      let releaseEnvelope;
      let announceEnvelope;
      const envelopeGate = new Promise(resolve => { releaseEnvelope = resolve; });
      const envelopeStarted = new Promise(resolve => { announceEnvelope = resolve; });
      data.createEnvelope = async payload => {
        announceEnvelope();
        await envelopeGate;
        return {
          format: 'buildbook-profile-export',
          version: 1,
          sourceSchemaVersion: 5,
          exportedAt: '2026-11-24T00:00:00.000Z',
          payload,
          sha256: 'a'.repeat(64),
        };
      };

      const migration = migrateProfileToLocalApi(data);
      await envelopeStarted;
      mutate(sourceProfile);
      releaseEnvelope();
      await migration;
      assert.deepEqual(data.readStored(), expected, 'the canonical import must use the pre-edit snapshot');
    });
  }
});


test('refuses to migrate when the canonical revision counter is exhausted', async () => {
  const data = fixture({ state: {}, logs: [], photos: {} });
  data.client.readProfile = async () => ({ revision: Number.MAX_SAFE_INTEGER, profile: null });
  let imports = 0;
  data.client.importProfile = async () => { imports += 1; return Number.MAX_SAFE_INTEGER; };
  await assert.rejects(migrateProfileToLocalApi(data), /Исчерпан диапазон ревизий/);
  assert.equal(imports, 0, 'an exhausted revision must be rejected before import');
});

test('does not report migration success for 20 invalid import revision results', async t => {
  const invalidRevisions = [
    undefined, null, false, true, '1', '', 0, -1, 1.5, NaN,
    Infinity, -Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1,
    2, 3, {}, [], new Number(1), 1n,
  ];
  for (const [index, invalidRevision] of invalidRevisions.entries()) {
    await t.test('invalid revision result #' + (index + 1), async () => {
      const sourceProfile = { state: { marker: 'source' }, logs: [], photos: {} };
      let stored = null;
      let storedRevision = 0;
      const client = {
        async readProfile() { return { revision: storedRevision, profile: stored }; },
        async importProfile(envelope, expectedRevision) {
          assert.equal(expectedRevision, 0);
          stored = envelope.payload;
          storedRevision = 1;
          return invalidRevision;
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

      await assert.rejects(
        migrateProfileToLocalApi({ client, sourceProfile, createEnvelope }),
        error => error.code === 'BUILD_BOOK_MIGRATION_VERIFY_FAILED',
      );
      assert.equal(storedRevision, 1, 'the read-back still observes the committed revision');
      assert.deepEqual(stored, { state: { marker: 'source' }, logs: [], photos: {} });
    });
  }
});


test('rejects 20 invalid export-envelope metadata variants before import', async t => {
  const mutations = [
    ['missing format', envelope => { delete envelope.format; }],
    ['wrong format', envelope => { envelope.format = 'other'; }],
    ['null format', envelope => { envelope.format = null; }],
    ['string version', envelope => { envelope.version = '1'; }],
    ['zero version', envelope => { envelope.version = 0; }],
    ['negative version', envelope => { envelope.version = -1; }],
    ['fractional version', envelope => { envelope.version = 1.5; }],
    ['unsupported version', envelope => { envelope.version = 2; }],
    ['missing schema version', envelope => { delete envelope.sourceSchemaVersion; }],
    ['string schema version', envelope => { envelope.sourceSchemaVersion = '5'; }],
    ['negative schema version', envelope => { envelope.sourceSchemaVersion = -1; }],
    ['unsupported schema version', envelope => { envelope.sourceSchemaVersion = 6; }],
    ['missing export date', envelope => { delete envelope.exportedAt; }],
    ['non-date export date', envelope => { envelope.exportedAt = 'yesterday'; }],
    ['empty export date', envelope => { envelope.exportedAt = ''; }],
    ['missing checksum', envelope => { delete envelope.sha256; }],
    ['uppercase checksum', envelope => { envelope.sha256 = 'A'.repeat(64); }],
    ['short checksum', envelope => { envelope.sha256 = 'a'.repeat(63); }],
    ['long checksum', envelope => { envelope.sha256 = 'a'.repeat(65); }],
    ['non-hex checksum', envelope => { envelope.sha256 = 'g'.repeat(64); }],
  ];

  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const data = fixture({ state: { safe: true }, logs: [], photos: {} });
      let importCalls = 0;
      data.client.importProfile = async () => { importCalls += 1; return 1; };
      const makeEnvelope = data.createEnvelope;
      data.createEnvelope = async payload => {
        const envelope = await makeEnvelope(payload);
        mutate(envelope);
        return envelope;
      };
      await assert.rejects(migrateProfileToLocalApi(data), /некорректный конверт/);
      assert.equal(importCalls, 0, 'invalid envelope metadata must be rejected before import');
      assert.equal(data.readStored(), null);
      assert.equal(data.readRevision(), 0);
    });
  }
});


test('rejects 20 malformed canonical target read responses before import', async t => {
  const invalidTargets = [
    ['null response', null],
    ['undefined response', undefined],
    ['array response', []],
    ['string response', 'profile'],
    ['number response', 1],
    ['boolean response', false],
    ['missing revision', { profile: null }],
    ['string revision', { revision: '0', profile: null }],
    ['null revision', { revision: null, profile: null }],
    ['negative revision', { revision: -1, profile: null }],
    ['fractional revision', { revision: 0.25, profile: null }],
    ['NaN revision', { revision: NaN, profile: null }],
    ['infinite revision', { revision: Infinity, profile: null }],
    ['unsafe revision', { revision: Number.MAX_SAFE_INTEGER + 1, profile: null }],
    ['missing profile field', { revision: 0 }],
    ['undefined profile', { revision: 0, profile: undefined }],
    ['array profile', { revision: 0, profile: [] }],
    ['string profile', { revision: 0, profile: 'not-empty-object' }],
    ['number profile', { revision: 0, profile: 7 }],
    ['boolean profile', { revision: 0, profile: true }],
  ];

  for (const [name, target] of invalidTargets) {
    await t.test(name, async () => {
      const data = fixture({ state: {}, logs: [], photos: {} });
      let importCalls = 0;
      data.client.readProfile = async () => target;
      data.client.importProfile = async () => { importCalls += 1; return 1; };
      await assert.rejects(migrateProfileToLocalApi(data), /некорректное состояние/);
      assert.equal(importCalls, 0, 'malformed target response must not reach import');
    });
  }
});


test('rejects 20 malformed ISO export timestamps before import', async t => {
  const invalidDates = [
    '2026-11-24',
    '2026-11-24 00:00:00Z',
    'November 24, 2026',
    '2026/11/24T00:00:00Z',
    '2026-11-24T00:00:00',
    '2026-11-24T00:00Z',
    '2026-11-24T00:00:00.1234Z',
    '2026-11-24T00:00:00z',
    '2026-02-29T00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-01T00:00:00Z',
    '2026-11-00T00:00:00Z',
    '2026-11-24T24:00:00Z',
    '2026-11-24T00:60:00Z',
    '2026-11-24T00:00:60Z',
    '2026-11-24T00:00:00+14:01',
    '2026-11-24T00:00:00-15:00',
    '2026-11-24T00:00:00+01:60',
    '2026-11-24T00:00:00+1:00',
  ];

  for (const exportedAt of invalidDates) {
    await t.test(exportedAt, async () => {
      const data = fixture({ state: {}, logs: [], photos: {} });
      let importCalls = 0;
      data.client.importProfile = async () => { importCalls += 1; return 1; };
      const makeEnvelope = data.createEnvelope;
      data.createEnvelope = async payload => {
        const envelope = await makeEnvelope(payload);
        envelope.exportedAt = exportedAt;
        return envelope;
      };
      await assert.rejects(migrateProfileToLocalApi(data), /некорректный конверт/);
      assert.equal(importCalls, 0);
    });
  }
});
