import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';

async function loadHelpers() {
  const window = { crypto: webcrypto };
  const exporterSource = await readFile(new URL('../client/profile-export.js', import.meta.url), 'utf8');
  const importerSource = await readFile(new URL('../client/profile-import.js', import.meta.url), 'utf8');
  runInNewContext(exporterSource, { window, TextEncoder });
  runInNewContext(importerSource, { window, TextEncoder });
  return { exporter: window.BuildbookProfileExport, importer: window.BuildbookProfileImport };
}

test('validates a genuine exported profile and returns its byte size', async () => {
  const { exporter, importer } = await loadHelpers();
  const envelope = await exporter.createEnvelope({
    state: { transactions: [{ id: 'a1', amount: 150 }] },
    logs: [],
    photos: {},
  }, '2026-11-23T10:00:00.000Z');
  const validated = await importer.validateEnvelope(envelope);
  assert.equal(validated.sourceSchemaVersion, 5);
  assert.equal(validated.sizeBytes, new TextEncoder().encode(JSON.stringify(envelope.payload)).byteLength);
  assert.deepEqual(JSON.parse(JSON.stringify(validated.payload)), envelope.payload);
});

test('parses JSON and rejects malformed JSON or non-text input', async () => {
  const { importer } = await loadHelpers();
  await assert.rejects(importer.parseAndValidate('{broken'), /корректный JSON/);
  await assert.rejects(importer.parseAndValidate({}), /должно быть текстом/);
});

test('rejects checksum tampering and unsupported schema versions', async () => {
  const { exporter, importer } = await loadHelpers();
  const envelope = await exporter.createEnvelope({ state: {}, logs: [], photos: {} });
  await assert.rejects(importer.validateEnvelope({ ...envelope, sha256: '0'.repeat(64) }), /Контрольная сумма не совпадает/);
  await assert.rejects(importer.validateEnvelope({ ...envelope, sourceSchemaVersion: 999 }), /схемы профиля.*не поддерживается/);
});

test('rejects extra envelope or payload fields rather than silently importing them', async () => {
  const { exporter, importer } = await loadHelpers();
  const envelope = await exporter.createEnvelope({ state: {}, logs: [], photos: {} });
  await assert.rejects(importer.validateEnvelope({ ...envelope, apiToken: 'secret' }), /неизвестные поля конверта/);
  const payload = { ...envelope.payload, hostMetadata: { token: 'secret' } };
  const altered = { ...envelope, payload };
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
  altered.sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  await assert.rejects(importer.validateEnvelope(altered), /неподдерживаемые поля/);
});

test('rejects oversized raw JSON before parsing and non-ISO export dates', async () => {
  const { exporter, importer } = await loadHelpers();
  const envelope = await exporter.createEnvelope({ state: {}, logs: [], photos: {} });
  await assert.rejects(importer.parseAndValidate(' '.repeat(34 * 1024 * 1024 + 1)), /34 MiB/);
  await assert.rejects(importer.validateEnvelope({ ...envelope, exportedAt: 'November 23, 2026' }), /некорректная дата/);
});

test('rejects malformed envelope fields and oversized payloads', async () => {
  const { exporter, importer } = await loadHelpers();
  const envelope = await exporter.createEnvelope({ state: {}, logs: [], photos: {} });
  await assert.rejects(importer.validateEnvelope({ ...envelope, sha256: 'xyz' }), /неверный формат/);
  await assert.rejects(importer.validateEnvelope({ ...envelope, exportedAt: 'bad-date' }), /некорректная дата/);
  const oversized = {
    ...envelope,
    payload: { state: { data: 'x'.repeat(32 * 1024 * 1024 + 1) }, logs: [], photos: {} },
  };
  await assert.rejects(importer.validateEnvelope(oversized), /32 MiB/);
});
