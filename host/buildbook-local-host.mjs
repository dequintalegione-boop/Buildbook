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

  let pairingUntil = 0;
  const placeholderUser = '9000000000000001';
  const envBotToken = /^(\d{1,16}):[A-Za-z0-9_-]{10,}$/.test(String(env.BUILDBOOK_TELEGRAM_BOT_TOKEN || '').trim())
    && !String(env.BUILDBOOK_TELEGRAM_BOT_TOKEN).includes('REPLACE')
    ? String(env.BUILDBOOK_TELEGRAM_BOT_TOKEN).trim()
    : '';

  function mountTelegram(config) {
    telegram = createTelegramHostService({
      config,
      profileStore,
      fetchImpl,
      onError,
      onSkipped: update => noteSkipped(update),
    });
  }

  async function noteSkipped(update) {
    if (!pairingUntil || Date.now() > pairingUntil || !telegram?.gate) return;
    const userId = String(update?.message?.from?.id ?? '');
    if (update?.message?.chat?.type !== 'private' || !/^\d{1,16}$/.test(userId) || userId === placeholderUser) return;
    try {
      telegram.gate.allow(userId);
      telegram.gate.revoke(placeholderUser);
    } catch {
      return;
    }
    const ids = telegram.gate.list().filter(id => id !== placeholderUser);
    setupView = { ...setupView, allowedUserIds: ids };
    pairingUntil = 0;
    if (secretRecord) {
      secretRecord = { ...secretRecord, allowedUserIds: ids.length ? ids : [placeholderUser] };
      writeTelegramSetupFile(telegramPaths.setupPath, secretRecord).catch(() => {});
    }
    try { await telegram.notify(String(update.message.chat?.id ?? userId), 'Доступ к Buildbook открыт. Напишите /help'); } catch {}
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
      pairingUntil: pairingUntil > Date.now() ? pairingUntil : null,
      needsToken: !setupView.configured && !envBotToken,
      hostTokenReady: !setupView.configured && !!envBotToken,
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

  function beginTelegramLoop() {
    const loop = telegram.service.start();
    loop.catch(error => { try { onError(error, { phase: 'telegram-loop' }); } catch {} });
  }

  async function persistSecret(patch) {
    if (!secretRecord) return;
    secretRecord = { ...secretRecord, ...patch };
    await writeTelegramSetupFile(telegramPaths.setupPath, secretRecord);
  }

  async function controlTelegram(input) {
    const action = String(input?.action || '');
    if (action === 'pair') {
      if (!telegram) {
        const error = new Error('Сначала подключите бота.');
        error.status = 409;
        throw error;
      }
      pairingUntil = Date.now() + 180000;
      if (!telegram.getStatus().running) beginTelegramLoop();
      return currentSetup();
    }
    if (action === 'cancel-pair') {
      pairingUntil = 0;
      return currentSetup();
    }
    if (action === 'remove-user') {
      if (!telegram?.gate) {
        const error = new Error('Бот ещё не подключён.');
        error.status = 409;
        throw error;
      }
      telegram.gate.revoke(input.userId);
      if (!telegram.gate.list().some(id => id !== placeholderUser)) telegram.gate.allow(placeholderUser);
      const ids = telegram.gate.list().filter(id => id !== placeholderUser);
      setupView = { ...setupView, allowedUserIds: ids };
      await persistSecret({ allowedUserIds: telegram.gate.list() });
      return currentSetup();
    }
    if (action === 'account') {
      const accountId = String(input.accountId || '').trim();
      const botToken = secretRecord?.botToken || envBotToken;
      const allowedUserIds = (secretRecord?.allowedUserIds || setupView.allowedUserIds || []).filter(Boolean);
      return applyTelegramSetupBody({
        botToken,
        allowedUserIds: allowedUserIds.length ? allowedUserIds : [placeholderUser],
        defaultAccountId: accountId,
        start: telegram?.getStatus().running === true,
      });
    }
    if (action === 'adopt-host' || action === 'save-token') {
      const botToken = action === 'adopt-host' ? envBotToken : String(input.botToken || '').trim();
      const allowedUserIds = setupView.allowedUserIds.length ? setupView.allowedUserIds : [placeholderUser];
      const view = await applyTelegramSetupBody({
        botToken,
        allowedUserIds,
        defaultAccountId: setupView.defaultAccountId || '',
        start: true,
      });
      pairingUntil = setupView.allowedUserIds.some(id => id !== placeholderUser) ? 0 : Date.now() + 180000;
      return currentSetup() || view;
    }
    if (action === 'start') {
      if (!telegram) {
        const error = new Error('Сначала подключите бота.');
        error.status = 409;
        throw error;
      }
      beginTelegramLoop();
      return currentSetup();
    }
    if (action === 'stop') {
      if (!telegram) {
        const error = new Error('Сначала подключите бота.');
        error.status = 409;
        throw error;
      }
      await telegram.service.stop();
      return currentSetup();
    }
    if (action === 'restart') {
      if (!telegram) {
        const error = new Error('Сначала подключите бота.');
        error.status = 409;
        throw error;
      }
      await telegram.service.stop();
      beginTelegramLoop();
      return currentSetup();
    }
    if (action === 'autostart-on' || action === 'autostart-off') {
      autoStartTelegram = action === 'autostart-on' && setupView.configured;
      await persistSecret({ autostart: autoStartTelegram });
      return currentSetup();
    }
    const error = new Error('Неизвестная команда.');
    error.status = 400;
    throw error;
  }

  const api = createLocalApiServer({
    profileStore,
    accessToken: required(env, 'BUILDBOOK_LOCAL_API_TOKEN'),
    getTelegramStatus: () => telegram ? { ...telegram.getStatus(), enabled: true } : { enabled: false, running: false },
    getTelegramSetup: currentSetup,
    applyTelegramSetup,
    controlTelegram,
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
