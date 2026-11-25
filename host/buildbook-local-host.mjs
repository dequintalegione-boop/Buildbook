import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProfileStore } from './profile-store.mjs';
import { createLocalApiServer } from './local-api.mjs';
import { acquireInstanceLock } from './instance-lock.mjs';
import { createTelegramHostService } from './telegram-host-service.mjs';
import { readTelegramServiceConfig } from './telegram-config.mjs';
import { createTelegramBotApi } from './telegram-bot-api.mjs';

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
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const telegramEnabledRaw = String(env.BUILDBOOK_TELEGRAM_ENABLED ?? 'false').trim().toLowerCase();
  if (!['true', 'false'].includes(telegramEnabledRaw)) throw new TypeError('BUILDBOOK_TELEGRAM_ENABLED must be true or false.');
  const telegramEnabled = telegramEnabledRaw === 'true';
  let telegram = null;
  const telegramBotApi = createTelegramBotApi({ fetchImpl });
  const api = createLocalApiServer({
    profileStore,
    accessToken: required(env, 'BUILDBOOK_LOCAL_API_TOKEN'),
    getTelegramStatus: () => telegram ? { ...telegram.getStatus(), enabled: true } : { enabled: false, running: false },
    startTelegram: () => {
      if (!telegram) throw new Error('Telegram не настроен. Сначала выполните мастер настройки.');
      const loop = telegram.service.start();
      loop.catch(error => { try { onError(error, { phase: 'telegram-loop' }); } catch {} });
    },
    stopTelegram: () => {
      if (!telegram) throw new Error('Telegram не настроен. Сначала выполните мастер настройки.');
      return telegram.service.stop();
    },
    verifyTelegramBot: token => telegramBotApi.getMe(token),
    host: String(env.BUILDBOOK_LOCAL_API_HOST || '127.0.0.1').trim(),
    port: parsePort(env),
    staticRoot: appRoot,
  });
  if (telegramEnabled) {
    const telegramConfig = readTelegramServiceConfig(env);
    for (const path of [telegramConfig.inboxPath, telegramConfig.offsetPath, telegramConfig.instanceLockPath]) {
      if (normalizedProfilePaths.has(resolve(path).toLowerCase())) throw new TypeError('Telegram queue/offset/lock paths must not overlap the canonical profile or its lock.');
    }
    telegram = createTelegramHostService({ config: telegramConfig, profileStore, fetchImpl, onError });
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
        if (telegram) {
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

  return Object.freeze({
    start,
    stop,
    get running() { return address !== null; },
    get telegramStatus() { return telegram ? { ...telegram.getStatus(), enabled: true } : { enabled: false, running: false }; },
  });
}
