import { mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync, lstatSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be inspected by this user.
    // Only ESRCH is proof that the recorded PID is not currently running.
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function readLockOwner(path) {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return null;
  const ownerPath = join(path, 'owner.json');
  const ownerInfo = lstatSync(ownerPath);
  if (ownerInfo.isSymbolicLink() || !ownerInfo.isFile() || ownerInfo.size > 4096) return null;
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    || typeof owner.ownerToken !== 'string' || !/^[0-9a-f-]{36}$/i.test(owner.ownerToken)
    || typeof owner.startedAt !== 'string' || !Number.isFinite(Date.parse(owner.startedAt))) return null;
  return owner;
}

/**
 * Reclaims a lock only when its well-formed owner record points to a PID that
 * the OS positively reports as absent. Rename is atomic within the same
 * directory, so only one contender can move a stale lock out of the way.
 * Unknown, unreadable, symlinked or still-live locks fail closed.
 */
function reclaimStaleLock(path, isAlive) {
  let owner;
  try {
    owner = readLockOwner(path);
  } catch {
    return false;
  }
  if (!owner) return false;
  let alive;
  try {
    alive = isAlive(owner.pid);
  } catch {
    return false;
  }
  if (alive !== false) return false;

  const quarantine = path + '.stale-' + randomUUID();
  try {
    renameSync(path, quarantine);
  } catch {
    return false;
  }

  try {
    const movedOwner = readLockOwner(quarantine);
    if (!movedOwner || movedOwner.pid !== owner.pid || movedOwner.ownerToken !== owner.ownerToken) {
      // The directory changed between inspection and rename. Restore it only
      // if no other contender has acquired the canonical lock path.
      try { renameSync(quarantine, path); } catch {}
      return false;
    }
    unlinkSync(join(quarantine, 'owner.json'));
    rmdirSync(quarantine);
    return true;
  } catch {
    // Leave an unremovable quarantine directory for manual inspection. Never
    // touch an unknown object or another process' newly acquired lock.
    return false;
  }
}

/**
 * Acquires an exclusive directory lock for one local service process.
 * A stale lock is reclaimed only after the OS confirms that its owner PID is
 * absent; permission errors and malformed ownership records remain fail-closed.
 */
export function acquireInstanceLock(lockPath, { pid = process.pid, isProcessAlive = processIsAlive } = {}) {
  if (typeof lockPath !== 'string' || !lockPath.trim()) {
    throw new TypeError('An absolute instance-lock path is required.');
  }
  const path = resolve(lockPath);
  if (path !== lockPath) throw new TypeError('Instance-lock path must be absolute.');
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('A valid process ID is required.');
  if (typeof isProcessAlive !== 'function') throw new TypeError('isProcessAlive must be a function.');

  mkdirSync(dirname(path), { recursive: true });
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (!reclaimStaleLock(path, isProcessAlive)) {
      const conflict = new Error('Другой экземпляр Buildbook уже работает либо его блокировка не может быть безопасно проверена.');
      conflict.code = 'BUILDBOOK_INSTANCE_LOCKED';
      throw conflict;
    }
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (retryError) {
      if (retryError?.code === 'EEXIST') {
        const conflict = new Error('Другой экземпляр Buildbook уже успел занять блокировку.');
        conflict.code = 'BUILDBOOK_INSTANCE_LOCKED';
        throw conflict;
      }
      throw retryError;
    }
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
