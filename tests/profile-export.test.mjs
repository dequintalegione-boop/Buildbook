import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';

async function loadExporter() {
  const source = await readFile(new URL('../client/profile-export.js', import.meta.url), 'utf8');
  const window = { crypto: webcrypto };
  runInNewContext(source, { window, TextEncoder });
  return window.BuildbookProfileExport;
}

test('creates a versioned backup envelope with only profile data and a SHA-256 digest', async () => {
  const exporter = await loadExporter();
  const envelope = await exporter.createEnvelope({
    state: { tx: [{ id: 'tx-1', amount: 120 }] },
    logs: [],
    photos: {},
    revision: 17,
    telegram: { idempotency: ['must-not-export'] },
    accessToken: 'must-not-export',
  }, '2026-11-23T10:00:00.000Z');

  assert.deepEqual(JSON.parse(JSON.stringify(envelope)), {
    format: 'buildbook-profile-export',
    version: 1,
    sourceSchemaVersion: 5,
    exportedAt: '2026-11-23T10:00:00.000Z',
    payload: { state: { tx: [{ id: 'tx-1', amount: 120 }] }, logs: [], photos: {} },
    sha256: envelope.sha256,
  });
  assert.match(envelope.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(envelope).includes('must-not-export'), false);
});

test('rejects malformed profile fields and invalid export timestamps', async () => {
  const exporter = await loadExporter();
  await assert.rejects(exporter.createEnvelope({ state: {}, logs: [], photos: {} }, 'not-a-date'), /дата экспорта/);
  for (const exportedAt of ['2026-01-01T10:00:00+14:01', '2026-01-01T10:00:00-14:01', '2026-01-01T10:00:00+15:00']) {
    await assert.rejects(exporter.createEnvelope({ state: {}, logs: [], photos: {} }, exportedAt), /дата экспорта/);
  }
  for (const exportedAt of ['2026-01-01T10:00:00+14:00', '2026-01-01T10:00:00-14:00']) {
    assert.equal((await exporter.createEnvelope({ state: {}, logs: [], photos: {} }, exportedAt)).exportedAt, exportedAt);
  }
  await assert.rejects(exporter.createEnvelope({ state: {}, logs: {}, photos: {} }), /массивом/);
  await assert.rejects(exporter.createEnvelope({ state: {}, logs: [], photos: [] }), /Фотографии/);
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(exporter.createEnvelope({ state: cyclic, logs: [], photos: {} }), /сериализуемые JSON-данные/);
});


test('refuses an export larger than the canonical profile limit', async () => {
  const exporter = await loadExporter();
  const oversized = 'x'.repeat(32 * 1024 * 1024 + 1);
  await assert.rejects(
    exporter.createEnvelope({ state: { oversized }, logs: [], photos: {} }),
    /32 MiB/,
  );
});
