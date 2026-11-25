import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const MAX_SETUP_BYTES = 16 * 1024;

export function telegramPathsFromEnv(env, profilePath) {
  const dir = dirname(resolve(profilePath));
  const pick = (key, fallback) => {
    const value = String(env[key] ?? '').trim();
    return resolve(value || fallback);
  };
  return {
    inboxPath: pick('BUILDBOOK_TELEGRAM_INBOX_PATH', join(dir, 'telegram-inbox.json')),
    offsetPath: pick('BUILDBOOK_TELEGRAM_OFFSET_PATH', join(dir, 'telegram-offset.json')),
    instanceLockPath: pick('BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH', join(dir, 'telegram.lock')),
    setupPath: pick('BUILDBOOK_TELEGRAM_SETUP_PATH', join(dir, 'telegram-setup.json')),
  };
}

export function normalizeAllowedUserIds(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/);
  const ids = raw.map(item => String(item ?? '').trim()).filter(Boolean);
  if (!ids.length || ids.length > 100 || ids.some(id => !/^\d{1,16}$/.test(id)
    || !Number.isSafeInteger(Number(id)) || Number(id) <= 0 || String(Number(id)) !== id)) {
    throw new TypeError('Разрешены от 1 до 100 положительных числовых Telegram user ID.');
  }
  return [...new Set(ids.map(id => String(Number(id))))];
}

export function readTelegramSetupFileSync(filePath) {
  if (!isAbsolute(filePath)) throw new TypeError('Путь настроек Telegram должен быть абсолютным.');
  let text;
  try {
    const bytes = readFileSync(filePath);
    if (bytes.length > MAX_SETUP_BYTES) return null;
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || parsed.version !== 1 || typeof parsed.botToken !== 'string' || !Array.isArray(parsed.allowedUserIds)) return null;
    return {
      version: 1,
      botToken: parsed.botToken,
      allowedUserIds: parsed.allowedUserIds.map(id => String(id)),
      defaultAccountId: typeof parsed.defaultAccountId === 'string' ? parsed.defaultAccountId : '',
      autostart: parsed.autostart === true,
    };
  } catch {
    return null;
  }
}

export async function readTelegramSetupFile(filePath) {
  if (!isAbsolute(filePath)) throw new TypeError('Путь настроек Telegram должен быть абсолютным.');
  let text;
  try {
    const bytes = await readFile(filePath);
    if (bytes.length > MAX_SETUP_BYTES) throw new RangeError('Файл настроек Telegram слишком большой.');
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const parsed = JSON.parse(text);
  if (!parsed || parsed.version !== 1 || typeof parsed.botToken !== 'string' || !Array.isArray(parsed.allowedUserIds)) return null;
  return {
    version: 1,
    botToken: parsed.botToken,
    allowedUserIds: parsed.allowedUserIds.map(id => String(id)),
    defaultAccountId: typeof parsed.defaultAccountId === 'string' ? parsed.defaultAccountId : '',
    autostart: parsed.autostart === true,
  };
}

export async function writeTelegramSetupFile(filePath, record) {
  if (!isAbsolute(filePath)) throw new TypeError('Путь настроек Telegram должен быть абсолютным.');
  const payload = JSON.stringify({
    version: 1,
    botToken: record.botToken,
    allowedUserIds: record.allowedUserIds,
    defaultAccountId: record.defaultAccountId || '',
    autostart: record.autostart === true,
  });
  if (Buffer.byteLength(payload, 'utf8') > MAX_SETUP_BYTES) throw new RangeError('Настройки Telegram слишком большие.');
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = filePath + '.' + randomBytes(6).toString('hex') + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try { await chmod(temporary, 0o600); } catch (error) { if (error.code !== 'EPERM' && error.code !== 'ENOTSUP') throw error; }
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  try { await chmod(filePath, 0o600); } catch (error) { if (error.code !== 'EPERM' && error.code !== 'ENOTSUP') throw error; }
}
