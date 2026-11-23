import { resolve } from 'node:path';
import { createProfileStore } from './profile-store.mjs';
import { createLocalApiServer } from './local-api.mjs';
import { acquireInstanceLock } from './instance-lock.mjs';
import { createTelegramHostService } from './telegram-host-service.mjs';
import { readTelegramServiceConfig } from './telegram-config.mjs';

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
  const profileLockPath = resolve(String(env.BUILDBOOK_PROFILE_LOCK_PATH || profilePath + '.api-lock'));
  const profileStore = createProfileStore(profilePath);
  const api = createLocalApiServer({
    profileStore,
    accessToken: required(env, 'BUILDBOOK_LOCAL_API_TOKEN'),
    host: String(env.BUILDBOOK_LOCAL_API_HOST || '127.0.0.1').trim(),
    port: env.BUILDBOOK_LOCAL_API_PORT == null || env.BUILDBOOK_LOCAL_API_PORT === ''
      ? 43127
      : Number(env.BUILDBOOK_LOCAL_API_PORT),
  });
  const telegram = createTelegramHostService({
    config: readTelegramServiceConfig(env),
    profileStore,
    fetchImpl,
    onError,
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
        telegramLoop = telegram.service.start();
        telegramLoop.catch(error => {
          try { onError(error, { phase: 'telegram-loop' }); } catch {}
        });
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
      await telegram.service.stop();
      telegramLoop = null;
      await api.close();
      address = null;
      if (releaseProfileLock) {
        releaseProfileLock();
        releaseProfileLock = null;
      }
    })().finally(() => { stopPromise = null; });
    return stopPromise;
  }

  return Object.freeze({
    start,
    stop,
    get running() { return address !== null; },
    get telegramStatus() { return telegram.getStatus(); },
  });
}
