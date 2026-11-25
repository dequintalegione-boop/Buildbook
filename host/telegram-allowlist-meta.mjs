import { readFile, writeFile, mkdir, rename, open, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function normalizeComment(value) {
  if (value == null) return '';
  const text = String(value).trim().slice(0, 120);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new TypeError('Comment contains control characters.');
  return text;
}

function normalizeId(value) {
  const raw = String(value || '').trim();
  if (!/^[1-9]\d{0,15}$/.test(raw)) return null;
  return raw;
}

export async function readAllowlistMeta(metaPath) {
  const path = resolve(metaPath);
  try {
    const raw = await readFile(path, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !Array.isArray(data.users)) return { users: [] };
    const users = [];
    for (const row of data.users) {
      if (!row || typeof row !== 'object') continue;
      const id = normalizeId(row.id);
      if (!id) continue;
      users.push({ id, comment: normalizeComment(row.comment) });
    }
    return { users };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { users: [] };
    throw error;
  }
}

export async function writeAllowlistMeta(metaPath, users) {
  if (!Array.isArray(users)) throw new TypeError('users must be an array');
  if (users.length > 100) throw new TypeError('Allowlist cannot exceed 100 users.');
  const normalized = [];
  const seen = new Set();
  for (const row of users) {
    const id = normalizeId(row?.id);
    if (!id) throw new TypeError('Invalid Telegram user ID.');
    if (seen.has(id)) continue;
    seen.add(id);
    normalized.push({ id, comment: normalizeComment(row?.comment) });
  }
  const path = resolve(metaPath);
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  const payload = JSON.stringify({ version: 1, users: normalized }, null, 2) + '\n';
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { users: normalized };
}
