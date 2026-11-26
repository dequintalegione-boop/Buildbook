import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireInstanceLock } from '../host/instance-lock.mjs';

test('instance lock rejects a second owner and can be reacquired after release', () => {
  const root = mkdtempSync(join(tmpdir(), 'buildbook-lock-'));
  const path = join(root, 'service.lock');
  try {
    const release = acquireInstanceLock(path, { pid: 1234, isProcessAlive: () => true });
    assert.throws(() => acquireInstanceLock(path, { pid: 5678, isProcessAlive: () => true }), error => {
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

test('does not release a lock whose ownership marker changed', () => {
  const root = mkdtempSync(join(tmpdir(), 'buildbook-lock-'));
  const path = join(root, 'service.lock');
  try {
    const release = acquireInstanceLock(path, { pid: 1234 });
    const ownerPath = join(path, 'owner.json');
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    const originalOwnerToken = owner.ownerToken;
    owner.ownerToken = 'replaced-owner';
    writeFileSync(ownerPath, JSON.stringify(owner));
    assert.throws(() => release(), /ownership changed/);
    assert.throws(() => acquireInstanceLock(path, { isProcessAlive: () => true }), error => error.code === 'BUILDBOOK_INSTANCE_LOCKED');
    owner.ownerToken = originalOwnerToken;
    writeFileSync(ownerPath, JSON.stringify(owner));
    release();
    const releaseAgain = acquireInstanceLock(path);
    releaseAgain();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reclaims a well-formed lock only when the operating system confirms its owner is gone', () => {
  const root = mkdtempSync(join(tmpdir(), 'buildbook-lock-stale-'));
  const path = join(root, 'service.lock');
  try {
    const oldRelease = acquireInstanceLock(path, { pid: 1234, isProcessAlive: () => true });
    // Simulate an uncatchable process termination: leave its lock on disk.
    void oldRelease;
    assert.throws(() => acquireInstanceLock(path, { pid: 5678, isProcessAlive: () => true }),
      error => error.code === 'BUILDBOOK_INSTANCE_LOCKED');
    const release = acquireInstanceLock(path, { pid: 5678, isProcessAlive: () => false });
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not reclaim malformed locks or locks whose owner cannot be checked', () => {
  const root = mkdtempSync(join(tmpdir(), 'buildbook-lock-unknown-'));
  const path = join(root, 'service.lock');
  try {
    const release = acquireInstanceLock(path, { pid: 1234, isProcessAlive: () => true });
    void release;
    assert.throws(() => acquireInstanceLock(path, { pid: 5678, isProcessAlive: () => { throw new Error('access denied'); } }),
      error => error.code === 'BUILDBOOK_INSTANCE_LOCKED');
    writeFileSync(join(path, 'owner.json'), '{broken');
    assert.throws(() => acquireInstanceLock(path, { pid: 5678, isProcessAlive: () => false }),
      error => error.code === 'BUILDBOOK_INSTANCE_LOCKED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
