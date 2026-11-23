import { mkdir, rmdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * Acquires an exclusive directory lock for a single local service process.
 * A stale lock is deliberately not removed automatically: guessing that its
 * owner is dead can allow two writers to corrupt the inbox/profile.
 */
export async function acquireInstanceLock(lockPath, { pid = process.pid } = {}) {
  if (typeof lockPath !== 'string' || !lockPath.trim()) {
    throw new TypeError('An absolute instance-lock path is required.');
  }
  const path = resolve(lockPath);
  if (path !== lockPath) throw new TypeError('Instance-lock path must be absolute.');
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('A valid process ID is required.');

  await mkdir(dirname(path), { recursive: true });
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const conflict = new Error('Another Buildbook service instance may already be running.');
      conflict.code = 'BUILDBOOK_INSTANCE_LOCKED';
      throw conflict;
    }
    throw error;
  }

  try {
    await writeFile(resolve(path, 'owner.json'), JSON.stringify({
      pid,
      startedAt: new Date().toISOString(),
    }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await rmdir(path).catch(() => {});
    throw error;
  }

  let released = false;
  return async function releaseInstanceLock() {
    if (released) return;
    released = true;
    // Remove only the owner marker and then the directory. Never recursively
    // delete a path that could have been replaced by another process.
    const { unlink } = await import('node:fs/promises');
    await unlink(resolve(path, 'owner.json'));
    await rmdir(path);
  };
}
