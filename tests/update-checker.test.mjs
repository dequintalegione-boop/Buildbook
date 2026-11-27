import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdateChecker } from '../host/update-checker.mjs';

const latest = 'a'.repeat(40);
const installed = 'b'.repeat(40);
const payload = { sha: latest, commit: { message: 'Release update\nDetails', committer: { date: '2026-11-27T10:00:00Z' } } };

async function fixture(t, marker = null, fetchImpl = async () => ({ ok: true, json: async () => payload })) {
  const root = await mkdtemp(join(tmpdir(), 'buildbook-update-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (marker) await writeFile(join(root, 'buildbook-install.json'), JSON.stringify(marker));
  return createUpdateChecker({ installRoot: root, fetchImpl, now: () => Date.parse('2026-11-27T12:00:00Z') });
}

test('update checker reports an available commit for a tracked installation', async t => {
  const check = await fixture(t, {
    schemaVersion: 1, repository: 'dequintalegione-boop/Buildbook', branch: 'main',
    commit: installed, installedAt: '2026-11-20T10:00:00Z',
  });
  const result = await check();
  assert.equal(result.installationTracked, true);
  assert.equal(result.installedCommit, installed);
  assert.equal(result.latestCommit, latest);
  assert.equal(result.updateAvailable, true);
  assert.equal(result.latestMessage, 'Release update');
});

test('update checker reports the installation as current when commits match', async t => {
  const check = await fixture(t, {
    schemaVersion: 1, repository: 'dequintalegione-boop/Buildbook', branch: 'main',
    commit: latest, installedAt: '2026-11-27T11:00:00Z',
  });
  assert.equal((await check()).updateAvailable, false);
});

test('update checker does not guess the installed version when marker is missing', async t => {
  const check = await fixture(t);
  const result = await check();
  assert.equal(result.installationTracked, false);
  assert.equal(result.installedCommit, null);
  assert.equal(result.updateAvailable, null);
});

test('update checker ignores markers for another repository or malformed commit', async t => {
  const check = await fixture(t, {
    schemaVersion: 1, repository: 'someone/else', branch: 'main',
    commit: installed, installedAt: '2026-11-20T10:00:00Z',
  });
  assert.equal((await check()).installationTracked, false);
});

test('update checker rejects an invalid GitHub response', async t => {
  const check = await fixture(t, null, async () => ({ ok: true, json: async () => ({ sha: 'not-a-commit' }) }));
  await assert.rejects(check(), { code: 'BUILDBOOK_UPDATE_INVALID_RESPONSE' });
});

test('update checker reports network failures without exposing low-level details', async t => {
  const check = await fixture(t, null, async () => { throw new Error('private network detail'); });
  await assert.rejects(check(), { code: 'BUILDBOOK_UPDATE_NETWORK_ERROR', message: /GitHub/ });
});
