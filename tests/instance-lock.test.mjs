import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireInstanceLock } from '../host/instance-lock.mjs';

test('instance lock rejects a second owner and can be reacquired after release', () => {
  const root = mkdtempSync(join(tmpdir(), 'buildbook-lock-'));
  const path = join(root, 'service.lock');
  try {
    const release = acquireInstanceLock(path, { pid: 1234 });
    assert.throws(() => acquireInstanceLock(path, { pid: 5678 }), error => {
      assert.equal(error.code, 'BUILDBOOK_INSTANCE_LOCKED');
      return true;
    });
    release();
    const releaseAgain = acquireInstanceLock(path, { pid: 5678 });
    releaseAgain();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('instance lock requires an absolute path and a valid pid', () => {
  assert.throws(() => acquireInstanceLock('relative.lock'), /absolute/);
  assert.throws(() => acquireInstanceLock('/tmp/buildbook.lock', { pid: 0 }), /process ID/);
});
