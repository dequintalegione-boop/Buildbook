import { dirname, resolve } from 'node:path';
import { createTelegramBotApi } from './telegram-bot-api.mjs';
import { readTelegramServiceConfig } from './telegram-config.mjs';
import { createTelegramHostService } from './telegram-host-service.mjs';
import { updateTelegramEnvFile } from './telegram-env-store.mjs';

export async function configureTelegramHost({
  token, userId, env, appRoot, profilePath, profileStore, fetchImpl = globalThis.fetch, onError = () => {},
} = {}) {
  if (typeof token !== 'string' || typeof userId !== 'string' || !/^[1-9]\d{0,15}$/.test(userId)) {
    throw new TypeError('A Telegram token and numeric user ID are required.');
  }
  const bot = await createTelegramBotApi({ fetchImpl }).getMe(token);
  if (String(token.split(':', 1)[0]) !== bot.id) throw new Error('Telegram returned a mismatched bot identity.');

  const stored = await profileStore.read();
  if (!stored?.profile?.state || typeof stored.profile.state !== 'object') {
    const error = new Error('Сначала подключите и заполните канонический файловый профиль Buildbook.');
    error.code = 'BUILD_BOOK_PROFILE_NOT_READY';
    throw error;
  }

  const dataDir = dirname(profilePath);
  const candidateEnv = {
    ...env,
    BUILDBOOK_TELEGRAM_BOT_TOKEN: token,
    BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS: userId,
    BUILDBOOK_TELEGRAM_INBOX_PATH: String(env.BUILDBOOK_TELEGRAM_INBOX_PATH || resolve(dataDir, 'telegram-inbox.json')),
    BUILDBOOK_TELEGRAM_OFFSET_PATH: String(env.BUILDBOOK_TELEGRAM_OFFSET_PATH || resolve(dataDir, 'telegram-offset.json')),
    BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH: String(env.BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH || resolve(dataDir, 'telegram.lock')),
    BUILDBOOK_TELEGRAM_ENABLED: 'false',
  };
  const config = readTelegramServiceConfig(candidateEnv);
  const normalizedProfilePaths = new Set([
    resolve(profilePath),
    resolve(env.BUILDBOOK_PROFILE_LOCK_PATH || profilePath + '.api-lock'),
  ].map(path => process.platform === 'win32' ? path.toLowerCase() : path));
  for (const path of [config.inboxPath, config.offsetPath, config.instanceLockPath]) {
    const normalized = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    if (normalizedProfilePaths.has(normalized)) {
      throw new TypeError('Telegram queue, offset and lock paths must not overlap the canonical profile or its lock.');
    }
  }

  await updateTelegramEnvFile({
    envFile: resolve(appRoot, '.env'),
    values: {
      BUILDBOOK_TELEGRAM_BOT_TOKEN: token,
      BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS: userId,
      BUILDBOOK_TELEGRAM_INBOX_PATH: config.inboxPath,
      BUILDBOOK_TELEGRAM_OFFSET_PATH: config.offsetPath,
      BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH: config.instanceLockPath,
      BUILDBOOK_TELEGRAM_ENABLED: 'false',
    },
  });
  for (const key of [
    'BUILDBOOK_TELEGRAM_BOT_TOKEN',
    'BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS',
    'BUILDBOOK_TELEGRAM_INBOX_PATH',
    'BUILDBOOK_TELEGRAM_OFFSET_PATH',
    'BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH',
    'BUILDBOOK_TELEGRAM_ENABLED',
  ]) env[key] = candidateEnv[key];

  return Object.freeze({
    bot,
    telegram: createTelegramHostService({ config, profileStore, fetchImpl, onError }),
  });
}
