import { isAbsolute, relative, resolve, sep } from 'node:path';

function requiredString(env, name) {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new TypeError(name + ' is required.');
  return value;
}

function boundedInteger(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw == null || raw === '') return fallback;
  if (!/^\d+$/.test(String(raw))) throw new TypeError(name + ' must be an integer.');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(name + ' must be between ' + min + ' and ' + max + '.');
  }
  return value;
}

/**
 * Reads host-only Telegram settings without logging or exposing the bot token.
 * Paths must be explicitly configured so inbox files do not land in the repo.
 */
export function readTelegramServiceConfig(env = process.env) {
  const botToken = requiredString(env, 'BUILDBOOK_TELEGRAM_BOT_TOKEN');
  const tokenMatch = /^(\d+):([A-Za-z0-9_-]+)$/.exec(botToken);
  if (!tokenMatch || botToken.length > 256 || tokenMatch[1].length > 16
    || !Number.isSafeInteger(Number(tokenMatch[1])) || Number(tokenMatch[1]) <= 0) {
    throw new TypeError('BUILDBOOK_TELEGRAM_BOT_TOKEN has an invalid format.');
  }

  const allowlistRaw = requiredString(env, 'BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS');
  const rawUserIds = allowlistRaw.split(',').map(value => value.trim());
  if (!rawUserIds.length || rawUserIds.length > 100 || rawUserIds.some(value => !/^\d{1,16}$/.test(value)
    || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) {
    throw new TypeError('BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS must contain 1–100 positive numeric IDs.');
  }
  const allowedUserIds = [...new Set(rawUserIds.map(value => String(Number(value))))];

  const inboxPath = requiredString(env, 'BUILDBOOK_TELEGRAM_INBOX_PATH');
  const offsetPath = requiredString(env, 'BUILDBOOK_TELEGRAM_OFFSET_PATH');
  const instanceLockPath = requiredString(env, 'BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH');
  if (!isAbsolute(inboxPath) || !isAbsolute(offsetPath) || !isAbsolute(instanceLockPath)) {
    throw new TypeError('Telegram inbox, offset and instance-lock paths must be absolute.');
  }
  const normalizedPaths = [resolve(inboxPath), resolve(offsetPath), resolve(instanceLockPath)].map(path => path.toLowerCase());
  const pathsOverlap = (left, right) => {
    const rel = relative(left, right);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
  };
  if (normalizedPaths.some((path, index) => normalizedPaths.some((other, otherIndex) =>
    index !== otherIndex && pathsOverlap(path, other)))) {
    throw new TypeError('Telegram inbox, offset and instance-lock paths must not overlap.');
  }

  const retryBaseMs = boundedInteger(env, 'BUILDBOOK_TELEGRAM_RETRY_BASE_MS', 1000, 100, 60000);
  const retryMaxMs = boundedInteger(env, 'BUILDBOOK_TELEGRAM_RETRY_MAX_MS', 60000, 100, 3600000);
  if (retryMaxMs < retryBaseMs) throw new RangeError('BUILDBOOK_TELEGRAM_RETRY_MAX_MS must be at least the retry base.');

  return Object.freeze({
    botToken,
    botId: tokenMatch[1],
    allowedUserIds: Object.freeze(allowedUserIds),
    inboxPath: resolve(inboxPath),
    offsetPath: resolve(offsetPath),
    instanceLockPath: resolve(instanceLockPath),
    timeoutSeconds: boundedInteger(env, 'BUILDBOOK_TELEGRAM_TIMEOUT_SECONDS', 25, 0, 50),
    intervalMs: boundedInteger(env, 'BUILDBOOK_TELEGRAM_INTERVAL_MS', 1000, 0, 60000),
    retryBaseMs,
    retryMaxMs,
  });
}
