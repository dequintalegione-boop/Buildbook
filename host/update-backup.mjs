import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_UPDATE_FILES = 10_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MANIFEST_NAME = 'backup-manifest.json';
const PROTECTED_SEGMENTS = new Set(['.env', 'data', '.git', 'node_modules', 'backups']);

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

function validateRelativePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512
    || value.includes('\\') || value.includes('\0') || value.startsWith('/')
    || /^[a-zA-Z]:/.test(value)) {
    throw new TypeError('Update manifest contains an invalid relative path.');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.length > 128)
    || parts.some(part => PROTECTED_SEGMENTS.has(part.toLowerCase()))
    || parts[0].toLowerCase().startsWith('.env')) {
    throw new TypeError('Update manifest contains a protected or unsafe path.');
  }
  return parts.join('/');
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function resolveRegularFile(root, relativePath, { allowMissing = true } = {}) {
  const parts = relativePath.split('/');
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error?.code === 'ENOENT' && allowMissing) return null;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error('Symbolic links are not allowed in update paths.');
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error('An update path parent is not a directory.');
    if (index === parts.length - 1 && !info.isFile()) throw new Error('Update paths must reference regular files only.');
  }
  return current;
}

async function validateRoots(installRoot, backupRoot, { createBackupRoot = false } = {}) {
  if (typeof installRoot !== 'string' || !isAbsolute(installRoot)
    || typeof backupRoot !== 'string' || !isAbsolute(backupRoot)) {
    throw new TypeError('Absolute installRoot and backupRoot paths are required.');
  }
  const installReal = await realpath(installRoot);
  if (createBackupRoot) await mkdir(backupRoot, { recursive: true });
  const backupReal = await realpath(backupRoot);
  if (isInside(installReal, backupReal) || isInside(backupReal, installReal)) {
    throw new Error('Backup storage must be outside the application installation directory.');
  }
  const installInfo = await stat(installReal);
  const backupInfo = await stat(backupReal);
  if (!installInfo.isDirectory() || !backupInfo.isDirectory()) throw new Error('Install and backup roots must be directories.');
  return { installReal, backupReal };
}

function normalizeUpdatePaths(paths) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_UPDATE_FILES) {
    throw new TypeError('A list of 1 to 10000 update paths is required.');
  }
  const normalized = paths.map(validateRelativePath);
  if (new Set(normalized).size !== normalized.length) throw new TypeError('Update manifest contains duplicate paths.');
  return normalized.sort();
}

async function writeManifest(backupPath, manifest) {
  const tempPath = join(backupPath, MANIFEST_NAME + '.' + randomUUID() + '.tmp');
  await writeFile(tempPath, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  await rename(tempPath, join(backupPath, MANIFEST_NAME));
}

export async function createUpdateBackup({ installRoot, backupRoot, updatePaths, now = Date.now } = {}) {
  const paths = normalizeUpdatePaths(updatePaths);
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  const { installReal, backupReal } = await validateRoots(installRoot, backupRoot, { createBackupRoot: true });
  const backupId = new Date(now()).toISOString().replace(/[:.]/g, '-') + '-' + randomUUID();
  const backupPath = join(backupReal, backupId);
  await mkdir(backupPath, { recursive: false, mode: 0o700 });
  const files = [];
  let totalBytes = 0;
  try {
    for (const relativePath of paths) {
      const sourcePath = await resolveRegularFile(installReal, relativePath);
      if (!sourcePath) {
        files.push({ path: relativePath, existed: false, size: 0, sha256: null });
        continue;
      }
      const info = await stat(sourcePath);
      if (info.size > MAX_FILE_BYTES || totalBytes + info.size > MAX_TOTAL_BYTES) {
        throw new Error('The update backup exceeds the configured size limit.');
      }
      const bytes = await readFile(sourcePath);
      const digest = hash(bytes);
      const destination = join(backupPath, 'files', ...relativePath.split('/'));
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
      totalBytes += bytes.length;
      files.push({ path: relativePath, existed: true, size: bytes.length, sha256: digest });
    }
    const manifest = {
      schemaVersion: 1,
      backupId,
      createdAt: new Date(now()).toISOString(),
      fileCount: files.length,
      totalBytes,
      files,
    };
    await writeManifest(backupPath, manifest);
    return Object.freeze({ backupId, backupPath, fileCount: files.length, totalBytes, createdAt: manifest.createdAt });
  } catch (error) {
    await rm(backupPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function validateBackupManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1
    || typeof value.backupId !== 'string' || value.backupId.length > 128
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > MAX_UPDATE_FILES
    || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0 || value.totalBytes > MAX_TOTAL_BYTES
    || value.fileCount !== value.files.length) {
    throw new Error('The update backup manifest is invalid.');
  }
  const seen = new Set();
  let total = 0;
  const files = value.files.map(entry => {
    const path = validateRelativePath(entry?.path);
    if (seen.has(path)) throw new Error('The update backup manifest contains duplicate paths.');
    seen.add(path);
    if (typeof entry.existed !== 'boolean'
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES
      || (entry.existed && !/^[a-f0-9]{64}$/.test(String(entry.sha256 || '')))
      || (!entry.existed && (entry.size !== 0 || entry.sha256 !== null))) {
      throw new Error('The update backup manifest contains invalid file metadata.');
    }
    total += entry.size;
    return { path, existed: entry.existed, size: entry.size, sha256: entry.sha256 };
  });
  if (total !== value.totalBytes || total > MAX_TOTAL_BYTES) throw new Error('The update backup manifest size does not match its files.');
  return { backupId: value.backupId, createdAt: value.createdAt, totalBytes: total, files };
}

export async function restoreUpdateBackup({ installRoot, backupPath } = {}) {
  if (typeof backupPath !== 'string' || !isAbsolute(backupPath)) throw new TypeError('An absolute backupPath is required.');
  const installReal = await realpath(installRoot);
  const backupReal = await realpath(backupPath);
  if (isInside(installReal, backupReal) || isInside(backupReal, installReal)) {
    throw new Error('Backup storage must be outside the application installation directory.');
  }
  const manifestPath = join(backupReal, MANIFEST_NAME);
  const manifestInfo = await lstat(manifestPath);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) throw new Error('The update backup manifest is not a regular file.');
  const manifest = validateBackupManifest(JSON.parse(await readFile(manifestPath, 'utf8')));

  // Validate and hash every backup payload before changing any installed file.
  const verified = [];
  for (const entry of manifest.files) {
    const targetPath = await resolveRegularFile(installReal, entry.path);
    if (entry.existed) {
      const sourcePath = await resolveRegularFile(backupReal, 'files/' + entry.path, { allowMissing: false });
      const bytes = await readFile(sourcePath);
      if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) {
        throw new Error('An update backup file failed its integrity check.');
      }
      verified.push({ ...entry, targetPath, bytes });
    } else {
      verified.push({ ...entry, targetPath, bytes: null });
    }
  }

  let removedFiles = 0;
  for (const entry of verified) {
    const targetPath = entry.targetPath || join(installReal, ...entry.path.split('/'));
    // Re-check path components immediately before the write to reject a swapped symlink.
    const currentTarget = await resolveRegularFile(installReal, entry.path);
    if (entry.existed) {
      const destination = currentTarget || targetPath;
      await mkdir(dirname(destination), { recursive: true });
      const tempPath = destination + '.' + randomUUID() + '.restore-tmp';
      await writeFile(tempPath, entry.bytes, { flag: 'wx' });
      await rename(tempPath, destination);
    } else if (currentTarget) {
      await rm(currentTarget, { force: true });
      removedFiles += 1;
    }
  }
  return Object.freeze({ backupId: manifest.backupId, restoredFiles: verified.filter(entry => entry.existed).length, removedFiles });
}
