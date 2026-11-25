import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProfileStore } from './profile-store.mjs';
import { createLocalApiServer } from './local-api.mjs';
import { acquireInstanceLock } from './instance-lock.mjs';
import { createTelegramHostService } from './telegram-host-service.mjs';
import { readTelegramServiceConfig } from './telegram-config.mjs';
import { readTelegramSetupFileSync, normalizeAllowedUserIds, readTelegramSetupFile, telegramPathsFromEnv, writeTelegramSetupFile } from './telegram-setup-store.mjs';

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
  const telegramPaths = telegramPathsFromEnv(env, profilePath);
  for (const path of [telegramPaths.inboxPath, telegramPaths.offsetPath, telegramPaths.instanceLockPath, telegramPaths.setupPath]) {
    if (normalizedProfilePaths.has(resolve(path).toLowerCase())) throw new TypeError('Telegram queue/offset/lock paths must not overlap the canonical profile or its lock.');
  }
  let telegram = null;
  let autoStartTelegram = false;
  let setupView = { configured: false, botId: null, allowedUserIds: [], defaultAccountId: null };
  let secretRecord = null;
  let configureQueue = Promise.resolve();

  function configFromRecord(record) {
    return readTelegramServiceConfig({
      ...env,
      BUILDBOOK_TELEGRAM_BOT_TOKEN: record.botToken,
      BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS: record.allowedUserIds.join(','),
      BUILDBOOK_TELEGRAM_INBOX_PATH: telegramPaths.inboxPath,
      BUILDBOOK_TELEGRAM_OFFSET_PATH: telegramPaths.offsetPath,
      BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH: telegramPaths.instanceLockPath,
      BUILDBOOK_TELEGRAM_DEFAULT_ACCOUNT_ID: record.defaultAccountId || '',
    });
  }

  function rememberSetup(config, autostart, record) {
    setupView = {
      configured: true,
      botId: config.botId,
      allowedUserIds: [...config.allowedUserIds],
      defaultAccountId: config.defaultAccountId,
    };
    autoStartTelegram = autostart === true;
    if (record) secretRecord = { ...record, autostart: autoStartTelegram };
  }

  function mountTelegram(config) {
    telegram = createTelegramHostService({ config, profileStore, fetchImpl, onError });
  }

  const savedSetup = readTelegramSetupFileSync(telegramPaths.setupPath);
  if (telegramEnabled) {
    const telegramConfig = readTelegramServiceConfig({
      ...env,
      BUILDBOOK_TELEGRAM_INBOX_PATH: env.BUILDBOOK_TELEGRAM_INBOX_PATH || telegramPaths.inboxPath,
      BUILDBOOK_TELEGRAM_OFFSET_PATH: env.BUILDBOOK_TELEGRAM_OFFSET_PATH || telegramPaths.offsetPath,
      BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH: env.BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH || telegramPaths.instanceLockPath,
    });
    mountTelegram(telegramConfig);
    rememberSetup(telegramConfig, true);
  } else if (savedSetup) {
    try {
      const telegramConfig = configFromRecord(savedSetup);
      mountTelegram(telegramConfig);
      rememberSetup(telegramConfig, savedSetup.autostart === true, savedSetup);
    } catch {
      telegram = null;
    }
  }

  function currentSetup() {
    const status = telegram ? telegram.getStatus() : null;
    return {
      ...setupView,
      autostart: autoStartTelegram && setupView.configured,
      enabled: !!telegram,
      running: status?.running === true,
    };
  }

  async function applyTelegramSetup(input) {
    const run = configureQueue.then(() => applyTelegramSetupBody(input));
    configureQueue = run.catch(() => {});
    return run;
  }

  async function applyTelegramSetupBody(input) {
    const previous = setupView.configured ? await readTelegramSetupFile(telegramPaths.setupPath) : null;
    const botToken = String(input.botToken ?? '').trim() || previous?.botToken || '';
    if (!botToken) {
      const error = new Error('Нужен токен бота.');
      error.status = 400;
      throw error;
    }
    let allowedUserIds;
    try {
      allowedUserIds = normalizeAllowedUserIds(input.allowedUserIds);
    } catch (error) {
      error.status = 400;
      throw error;
    }
    const defaultAccountId = String(input.defaultAccountId ?? '').trim();
    if (defaultAccountId.length > 200) {
      const error = new Error('Некорректная касса.');
      error.status = 400;
      throw error;
    }
    const startNow = input.start !== false;
    let config;
    try {
      config = configFromRecord({ botToken, allowedUserIds, defaultAccountId });
    } catch (error) {
      error.status = 400;
      throw error;
    }
    await writeTelegramSetupFile(telegramPaths.setupPath, { botToken, allowedUserIds, defaultAccountId, autostart: startNow });
    if (telegram) {
      try { await telegram.service.stop(); } catch {}
      telegram = null;
    }
    mountTelegram(config);
    rememberSetup(config, startNow, { botToken, allowedUserIds, defaultAccountId, autostart: startNow });
    if (startNow && address) {
      const loop = telegram.service.start();
      loop.catch(error => { try { onError(error, { phase: 'telegram-loop' }); } catch {} });
    }
    return currentSetup();
  }

  const api = createLocalApiServer({
    profileStore,
    accessToken: required(env, 'BUILDBOOK_LOCAL_API_TOKEN'),
    getTelegramStatus: () => telegram ? { ...telegram.getStatus(), enabled: true } : { enabled: false, running: false },
    getTelegramSetup: currentSetup,
    applyTelegramSetup,
    startTelegram: () => {
      if (!telegram) throw new Error('Telegram не настроен. Сначала выполните мастер настройки.');
      autoStartTelegram = true;
      if (secretRecord) {
        secretRecord = { ...secretRecord, autostart: true };
        writeTelegramSetupFile(telegramPaths.setupPath, secretRecord).catch(() => {});
      }
      const loop = telegram.service.start();
      loop.catch(error => { try { onError(error, { phase: 'telegram-loop' }); } catch {} });
    },
    stopTelegram: () => {
      if (!telegram) throw new Error('Telegram не настроен. Сначала выполните мастер настройки.');
      autoStartTelegram = false;
      if (secretRecord) {
        secretRecord = { ...secretRecord, autostart: false };
        writeTelegramSetupFile(telegramPaths.setupPath, secretRecord).catch(() => {});
      }
      return telegram.service.stop();
    },
    host: String(env.BUILDBOOK_LOCAL_API_HOST || '127.0.0.1').trim(),
    port: parsePort(env),
    staticRoot: appRoot,
  });

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
        if (telegram && autoStartTelegram) {
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
