import { mkdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
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

  try {
    writeFileSync(resolve(path, 'owner.json'), JSON.stringify({
      pid,
      startedAt: new Date().toISOString(),
    }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    try { rmdirSync(path); } catch {}
    throw error;
  }

  let released = false;
  return function releaseInstanceLock() {
    if (released) return;
    released = true;
    unlinkSync(resolve(path, 'owner.json'));
    rmdirSync(path);
  };
}
