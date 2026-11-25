import { copyFile, lstat, mkdir, open, readFile, rename, rm, chmod } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ALLOWED_KEYS = new Set([
  'BUILDBOOK_TELEGRAM_BOT_TOKEN',
  'BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS',
  'BUILDBOOK_TELEGRAM_INBOX_PATH',
  'BUILDBOOK_TELEGRAM_OFFSET_PATH',
  'BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH',
  'BUILDBOOK_TELEGRAM_ENABLED',
]);

async function restrictFileAccess(path) {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('whoami.exe', [], { windowsHide: true, timeout: 5000 });
    const identity = String(stdout || '').trim();
    if (!identity || /[\r\n]/.test(identity)) throw new Error('Не удалось определить текущую учётную запись Windows.');
    await execFileAsync('icacls.exe', [path, '/inheritance:r', '/grant:r', identity + ':(F)'], {
      windowsHide: true,
      timeout: 10_000,
    });
    return;
  }
  await chmod(path, 0o600);
}

/**
 * Atomically updates only the allowlisted Telegram keys in the local .env.
 * The caller must pass the repository's fixed .env path, never a user path.
 */
export async function updateTelegramEnvFile({ envFile, values } = {}) {
  if (typeof envFile !== 'string' || !isAbsolute(envFile)) {
    throw new TypeError('Telegram environment file path must be absolute.');
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new TypeError('Telegram environment values are required.');
  }
  const keys = Object.keys(values);
  if (!keys.length || keys.some(key => !ALLOWED_KEYS.has(key))) {
    throw new TypeError('Only allowlisted Telegram environment keys can be changed.');
  }
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new TypeError('Invalid value for ' + key + '.');
    }
  }

  envFile = resolve(envFile);
  const parent = dirname(envFile);
  await mkdir(parent, { recursive: true });
  let details;
  try {
    details = await lstat(envFile);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Файл .env не найден. Сначала завершите первоначальную настройку локального хоста.');
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink() || details.size > 1024 * 1024) {
    throw new Error('Файл .env должен быть обычным файлом допустимого размера.');
  }

  const original = await readFile(envFile, 'utf8');
  const backupPath = envFile + '.backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID();
  await copyFile(envFile, backupPath);
  await restrictFileAccess(backupPath);

  const pending = new Set(keys);
  const lines = original.replace(/^\uFEFF/, '').split(/\r?\n/);
  const output = [];
  for (const line of lines) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (match && pending.has(match[1])) {
      const key = match[1];
      if (Object.hasOwn(values, key)) {
        output.push(key + '=' + values[key]);
        pending.delete(key);
      }
      continue;
    }
    output.push(line);
  }
  for (const key of pending) output.push(key + '=' + values[key]);

  const temporary = envFile + '.' + randomUUID() + '.tmp';
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(output.join('\n').replace(/\n+$/, '') + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await restrictFileAccess(temporary);
    await rename(temporary, envFile);
    if (process.platform !== 'win32') {
      const directory = await open(parent, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }

  return Object.freeze({ backedUp: true });
}
