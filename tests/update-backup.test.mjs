import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdateBackup, restoreUpdateBackup } from '../host/update-backup.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'buildbook-update-backup-'));
  const installRoot = join(root, 'app');
  const backupRoot = join(root, 'backups');
  await mkdir(installRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, installRoot, backupRoot };
}

test('backup captures only selected app files and restore rolls back changed and newly created files', async t => {
  const { installRoot, backupRoot } = await fixture(t);
  await mkdir(join(installRoot, 'host'), { recursive: true });
  await writeFile(join(installRoot, 'index.html'), 'old-ui');
  await writeFile(join(installRoot, 'host', 'local-api.mjs'), 'old-host');
  await writeFile(join(installRoot, 'user-note.txt'), 'keep-me');
  const backup = await createUpdateBackup({
    installRoot, backupRoot,
    updatePaths: ['index.html', 'host/local-api.mjs', 'new-module.mjs'],
    now: () => Date.parse('2026-11-27T12:00:00Z'),
  });
  assert.equal(backup.fileCount, 3);
  assert.equal(backup.totalBytes, 14);
  await writeFile(join(installRoot, 'index.html'), 'new-ui');
  await writeFile(join(installRoot, 'host', 'local-api.mjs'), 'new-host');
  await writeFile(join(installRoot, 'new-module.mjs'), 'new-file');
  const result = await restoreUpdateBackup({ installRoot, backupPath: backup.backupPath });
  assert.equal(result.restoredFiles, 2);
  assert.equal(result.removedFiles, 1);
  assert.equal(await readFile(join(installRoot, 'index.html'), 'utf8'), 'old-ui');
  assert.equal(await readFile(join(installRoot, 'host', 'local-api.mjs'), 'utf8'), 'old-host');
  await assert.rejects(readFile(join(installRoot, 'new-module.mjs')), { code: 'ENOENT' });
  assert.equal(await readFile(join(installRoot, 'user-note.txt'), 'utf8'), 'keep-me');
});

test('backup rejects path traversal, absolute paths and protected user data', async t => {
  const { installRoot, backupRoot } = await fixture(t);
  for (const updatePath of ['../outside.txt', '/absolute.txt', 'data/profile.json', '.env', '.env.backup', 'node_modules/pkg/index.js', 'host\\..\\secret']) {
    await assert.rejects(createUpdateBackup({ installRoot, backupRoot, updatePaths: [updatePath] }));
  }
});

test('backup refuses to follow symbolic links in the installation tree', async t => {
  const { installRoot, backupRoot, root } = await fixture(t);
  await writeFile(join(root, 'outside.txt'), 'secret');
  await symlink(join(root, 'outside.txt'), join(installRoot, 'linked.txt'));
  await assert.rejects(createUpdateBackup({ installRoot, backupRoot, updatePaths: ['linked.txt'] }), /Symbolic links/);
});

test('backup storage must be outside the application directory', async t => {
  const { installRoot } = await fixture(t);
  await assert.rejects(createUpdateBackup({
    installRoot, backupRoot: join(installRoot, 'backups'), updatePaths: ['index.html'],
  }), /outside the application/);
});

test('restore validates all backup hashes before modifying installed files', async t => {
  const { installRoot, backupRoot } = await fixture(t);
  await writeFile(join(installRoot, 'index.html'), 'original');
  const backup = await createUpdateBackup({ installRoot, backupRoot, updatePaths: ['index.html'] });
  await writeFile(join(installRoot, 'index.html'), 'changed');
  await writeFile(join(backup.backupPath, 'files', 'index.html'), 'tampered');
  await assert.rejects(restoreUpdateBackup({ installRoot, backupPath: backup.backupPath }), /integrity check/);
  assert.equal(await readFile(join(installRoot, 'index.html'), 'utf8'), 'changed');
});

test('restore rejects a corrupted or unsafe manifest', async t => {
  const { installRoot, backupRoot } = await fixture(t);
  await writeFile(join(installRoot, 'index.html'), 'original');
  const backup = await createUpdateBackup({ installRoot, backupRoot, updatePaths: ['index.html'] });
  await writeFile(join(backup.backupPath, 'backup-manifest.json'), JSON.stringify({
    schemaVersion: 1, backupId: 'bad', createdAt: '2026-11-27T12:00:00Z',
    fileCount: 1, totalBytes: 0,
    files: [{ path: '../escape', existed: false, size: 0, sha256: null }],
  }));
  await assert.rejects(restoreUpdateBackup({ installRoot, backupPath: backup.backupPath }));
});
