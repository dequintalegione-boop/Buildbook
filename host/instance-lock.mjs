import { mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

/**
 * Acquires an exclusive directory lock for one local service process.
 * Stale locks are intentionally not reclaimed automatically: guessing that
 * an owner is dead could permit two writers to corrupt the inbox/profile.
 */
export function acquireInstanceLock(lockPath, { pid = process.pid } = {}) {
  if (typeof lockPath !== 'string' || !lockPath.trim()) {
    throw new TypeError('An absolute instance-lock path is required.');
  }
  const path = resolve(lockPath);
  if (path !== lockPath) throw new TypeError('Instance-lock path must be absolute.');
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('A valid process ID is required.');

  mkdirSync(dirname(path), { recursive: true });
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const conflict = new Error('Another Buildbook service instance may already be running.');
      conflict.code = 'BUILDBOOK_INSTANCE_LOCKED';
      throw conflict;
    }
    throw error;
  }

  const ownerToken = randomUUID();
  const ownerPath = resolve(path, 'owner.json');
  try {
    writeFileSync(ownerPath, JSON.stringify({
      pid,
      ownerToken,
      startedAt: new Date().toISOString(),
    }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    // We created this directory exclusively. Remove a partially written owner
    // marker as well, otherwise a failed acquisition can leave a false stale lock.
    try { unlinkSync(ownerPath); } catch {}
    try { rmdirSync(path); } catch {}
    throw error;
  }

  let released = false;
  let ownerRemovedByThisRelease = false;
  return function releaseInstanceLock() {
    if (released) return;
    let owner;
    try {
      owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    } catch (error) {
      // A retry after this function removed its own marker may finish the
      // directory cleanup. Missing or unreadable ownership otherwise fails closed.
      if (!(ownerRemovedByThisRelease && error?.code === 'ENOENT')) {
        throw new Error('Buildbook instance lock ownership could not be verified; lock was left in place.');
      }
    }
    if (owner !== undefined && (owner?.ownerToken !== ownerToken || owner?.pid !== pid)) {
      throw new Error('Buildbook instance lock ownership changed; lock was left in place.');
    }
    if (!ownerRemovedByThisRelease) {
      unlinkSync(ownerPath);
      ownerRemovedByThisRelease = true;
    }
    rmdirSync(path);
    released = true;
  };
}
