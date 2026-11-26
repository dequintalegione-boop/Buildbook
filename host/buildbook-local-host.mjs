import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProfileStore } from './profile-store.mjs';
import { createLocalApiServer } from './local-api.mjs';
import { acquireInstanceLock } from './instance-lock.mjs';
import { createTelegramHostService } from './telegram-host-service.mjs';
import { readTelegramServiceConfig } from './telegram-config.mjs';
import { createTelegramBotApi } from './telegram-bot-api.mjs';
import { updateTelegramEnvFile } from './telegram-env-store.mjs';
import { configureTelegramHost } from './telegram-setup.mjs';
import { getWindowsRecoveryStatus } from './windows-recovery.mjs';
import { createTelegramAllowlistHandlers } from './telegram-allowlist-handlers.mjs';
import { createActivityLog } from './activity-log.mjs';

function parsePort(env) {
  const raw = env.BUILDBOOK_LOCAL_API_PORT;
  if (raw == null || raw === '') return 43127;
  if (!/^\d+$/.test(String(raw))) throw new TypeError('BUILDBOOK_LOCAL_API_PORT must be an integer.');
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new RangeError('BUILDBOOK_LOCAL_API_PORT must be between 0 and 65535.');
  }
  return port;
}

function required(env, key) {
  const value = String(env[key] ?? '').trim();
  if (!value) throw new TypeError(key + ' is required.');
  return value;
}

/**
 * Run the browser profile API and Telegram processor against one in-memory
 * profile-store instance. This is the supported composition boundary: do not
 * start a second profile store pointed at the same file in the same process.
 */
export function createBuildbookLocalHost({ env = process.env, fetchImpl = globalThis.fetch, onError = () => {} } = {}) {
  const profilePath = required(env, 'BUILDBOOK_PROFILE_PATH');
  if (!isAbsolute(profilePath)) throw new TypeError('BUILDBOOK_PROFILE_PATH must be an absolute path.');
  const profileLockRaw = String(env.BUILDBOOK_PROFILE_LOCK_PATH || profilePath + '.api-lock').trim();
  if (!isAbsolute(profileLockRaw)) throw new TypeError('BUILDBOOK_PROFILE_LOCK_PATH must be an absolute path.');
  const profileLockPath = resolve(profileLockRaw);
  const normalizedProfilePaths = new Set([resolve(profilePath), profileLockPath].map(path => path.toLowerCase()));
  if (normalizedProfilePaths.size !== 2) throw new TypeError('The profile file and its lock path must be distinct.');
  const profileStore = createProfileStore(profilePath);
  const activityLog = createActivityLog({ path: resolve(dirname(profilePath), 'host-activity.json') });
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const telegramEnabledRaw = String(env.BUILDBOOK_TELEGRAM_ENABLED ?? 'false').trim().toLowerCase();
  if (!['true', 'false'].includes(telegramEnabledRaw)) throw new TypeError('BUILDBOOK_TELEGRAM_ENABLED must be true or false.');
  let telegramEnabled = telegramEnabledRaw === 'true';
  const telegramBotToken = String(env.BUILDBOOK_TELEGRAM_BOT_TOKEN || '').trim();
  const telegramAllowedUserIds = String(env.BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS || '').trim().split(/[\s,]+/).filter(Boolean);
  const telegramConfigured = /^[1-9]\d{0,15}:[A-Za-z0-9_-]{20,}$/.test(telegramBotToken)
    && telegramAllowedUserIds.length >= 1 && telegramAllowedUserIds.length <= 100
    && telegramAllowedUserIds.every(id => /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id)));
  if (telegramEnabled && !telegramConfigured) {
    throw new TypeError('Telegram включён, но токен бота или белый список не настроены. Завершите мастер настройки Telegram.');
  }
  let telegram = null;
  let telegramBotProfile = null;
  let telegramBotProfileAt = 0;
  let telegramLatencyCache = null;
  let telegramLatencyAt = 0;
  let recoveryStatusCache = null;
  let recoveryStatusAt = 0;
  const telegramBotApi = createTelegramBotApi({ fetchImpl });
  function createConfiguredTelegram(config) {
    for (const path of [config.inboxPath, config.offsetPath, config.instanceLockPath]) {
      if (normalizedProfilePaths.has(resolve(path).toLowerCase())) throw new TypeError('Telegram inbox/offset/lock paths must not overlap the canonical profile or its lock.');
    }
    return createTelegramHostService({ config, profileStore, fetchImpl, onError });
  }
  const api = createLocalApiServer({
    profileStore,
    accessToken: required(env, 'BUILDBOOK_LOCAL_API_TOKEN'),
    getTelegramStatus: () => telegram ? { ...telegram.getStatus(), enabled: telegramEnabled, configured: true } : { enabled: false, configured: false, running: false },
    startTelegram: async () => {
      if (!telegram) throw new Error('Telegram не настроен. Сначала выполните мастер настройки.');
      await updateTelegramEnvFile({ envFile: resolve(appRoot, '.env'), values: { BUILDBOOK_TELEGRAM_ENABLED: 'true' } });
      env.BUILDBOOK_TELEGRAM_ENABLED = 'true';
      telegramEnabled = true;
      const loop = telegram.service.start();
      loop.catch(error => { try { onError(error, { phase: 'telegram-loop' }); } catch {} });
    },
    stopTelegram: async () => {
      if (!telegram) throw new Error('Telegram не настроен. Сначала выполните мастер настройки.');
      await updateTelegramEnvFile({ envFile: resolve(appRoot, '.env'), values: { BUILDBOOK_TELEGRAM_ENABLED: 'false' } });
      env.BUILDBOOK_TELEGRAM_ENABLED = 'false';
      telegramEnabled = false;
      return telegram.service.stop();
    },
    restartTelegram: async () => {
      if (!telegram) throw new Error('Telegram не настроен. Сначала выполните мастер настройки.');
      await telegram.service.stop();
      await updateTelegramEnvFile({ envFile: resolve(appRoot, '.env'), values: { BUILDBOOK_TELEGRAM_ENABLED: 'true' } });
      env.BUILDBOOK_TELEGRAM_ENABLED = 'true';
      telegramEnabled = true;
      const loop = telegram.service.start();
      loop.catch(error => { try { onError(error, { phase: 'telegram-loop' }); } catch {} });
    },
    verifyTelegramBot: token => telegramBotApi.getMe(token),
    configureTelegram: async ({ token, userId }) => {
      const configured = await configureTelegramHost({ token, userId, env, appRoot, profilePath, profileStore, fetchImpl, onError });
      if (telegram) await telegram.service.stop();
      telegram = configured.telegram;
      telegramBotProfile = configured.bot;
      telegramBotProfileAt = Date.now();
      telegramLatencyCache = null;
      telegramLatencyAt = 0;
      telegramEnabled = false;
      return configured.bot;
    },
    getHostRecoveryStatus: async () => {
      if (!recoveryStatusCache || Date.now() - recoveryStatusAt > 5_000) {
        recoveryStatusCache = await getWindowsRecoveryStatus();
        recoveryStatusAt = Date.now();
      }
      return recoveryStatusCache;
    },
    getTelegramMessages: () => telegram ? telegram.inbox.recent(50) : [],
    getActivityLog: ({ limit = 100, offset = 0 } = {}) => activityLog.recent(limit, offset),
    recordActivity: event => activityLog.record(event),
    ...createTelegramAllowlistHandlers({ env, appRoot, getTelegram: () => telegram }),
    getTelegramLatency: async () => {
      const token = String(env.BUILDBOOK_TELEGRAM_BOT_TOKEN || '');
      if (!token) return { latencyMs: null, checkedAt: null };
      if (!telegramLatencyCache || Date.now() - telegramLatencyAt > 30_000) {
        const startedAt = Date.now();
        await telegramBotApi.getMe(token);
        telegramLatencyCache = { latencyMs: Math.max(0, Date.now() - startedAt), checkedAt: new Date().toISOString() };
        telegramLatencyAt = Date.now();
      }
      return { ...telegramLatencyCache };
    },
    getTelegramBotProfile: async () => {
      const token = String(env.BUILDBOOK_TELEGRAM_BOT_TOKEN || '');
      if (!token) return null;
      if (!telegramBotProfile || Date.now() - telegramBotProfileAt > 5 * 60_000) {
        telegramBotProfile = await telegramBotApi.getMe(token);
        telegramBotProfileAt = Date.now();
      }
      return telegramBotProfile;
    },
    getTelegramCommands: () => {
      const token = String(env.BUILDBOOK_TELEGRAM_BOT_TOKEN || '');
      if (!token) throw new Error('Telegram bot is not configured.');
      return telegramBotApi.getMyCommands(token);
    },
    setTelegramCommands: commands => {
      const token = String(env.BUILDBOOK_TELEGRAM_BOT_TOKEN || '');
      if (!token) throw new Error('Telegram bot is not configured.');
      return telegramBotApi.setMyCommands(token, commands);
    },
    host: String(env.BUILDBOOK_LOCAL_API_HOST || '127.0.0.1').trim(),
    port: parsePort(env),
    staticRoot: appRoot,
  });
  if (telegramConfigured) {
    const telegramConfig = readTelegramServiceConfig(env);
    telegram = createConfiguredTelegram(telegramConfig);
  }

  let address = null;
  let releaseProfileLock = null;
  let startPromise = null;
  let stopPromise = null;
  let telegramLoop = null;

  async function start() {
    if (stopPromise) await stopPromise;
    if (address) return address;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      releaseProfileLock = acquireInstanceLock(profileLockPath);
      try {
        address = await api.listen();
        // start() synchronously acquires the Telegram instance lock before
        // returning its loop promise. Do not await the long-running loop.
        if (telegram && telegramEnabled) {
          telegramLoop = telegram.service.start();
          telegramLoop.catch(error => { try { onError(error, { phase: 'telegram-loop' }); } catch {} });
        }
        return address;
      } catch (error) {
        await api.close().catch(() => {});
        address = null;
        if (releaseProfileLock) {
          releaseProfileLock();
          releaseProfileLock = null;
        }
        if (error?.code === 'EADDRINUSE') {
          const conflict = new Error(`Порт локального хоста ${parsePort(env)} занят другим приложением. Закройте программу, использующую этот порт, или измените BUILDBOOK_LOCAL_API_PORT в .env. Buildbook не завершает сторонние процессы автоматически.`);
          conflict.code = 'BUILDBOOK_PORT_IN_USE';
          conflict.port = parsePort(env);
          conflict.cause = error;
          throw conflict;
        }
        if (error?.code === 'EACCES') {
          const conflict = new Error('Windows или другая служба запретила открыть порт локального хоста. Выберите свободный порт выше 1024 в BUILDBOOK_LOCAL_API_PORT.');
          conflict.code = 'BUILDBOOK_PORT_ACCESS_DENIED';
          conflict.cause = error;
          throw conflict;
        }
        throw error;
      }
    })().finally(() => { startPromise = null; });
    return startPromise;
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (startPromise) await startPromise.catch(() => {});
      let stopError = null;
      try {
        if (telegram) await telegram.service.stop();
      } catch (error) {
        stopError = error;
      }
      telegramLoop = null;
      try {
        await api.close();
      } catch (error) {
        stopError ||= error;
      } finally {
        address = null;
        if (releaseProfileLock) {
          try { releaseProfileLock(); } catch (error) { stopError ||= error; }
          releaseProfileLock = null;
        }
      }
      if (stopError) throw stopError;
    })().finally(() => { stopPromise = null; });
    return stopPromise;
  }

  function releaseLocksOnExit() {
    // Exit handlers are synchronous. Do not start new work here: the process
    // is already terminating and only verified, process-owned locks are freed.
    try { telegram?.service.releaseInstanceLockOnExit?.(); } catch {}
    if (releaseProfileLock) {
      const release = releaseProfileLock;
      releaseProfileLock = null;
      try { release(); } catch {}
    }
  }

  return Object.freeze({
    start,
    stop,
    releaseLocksOnExit,
    get running() { return address !== null; },
    get telegramStatus() { return telegram ? { ...telegram.getStatus(), enabled: telegramEnabled } : { enabled: false, running: false }; },
  });
}
