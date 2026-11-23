import { createProfileStore } from './profile-store.mjs';
import { createLocalApiServer } from './local-api.mjs';

function requiredEnv(env, key) {
  const value = String(env[key] ?? '').trim();
  if (!value) throw new TypeError(key + ' is required.');
  return value;
}

function readPort(env) {
  const raw = env.BUILDBOOK_LOCAL_API_PORT;
  if (raw == null || raw === '') return 43127;
  if (!/^\d+$/.test(String(raw))) throw new TypeError('BUILDBOOK_LOCAL_API_PORT must be an integer.');
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new RangeError('BUILDBOOK_LOCAL_API_PORT must be between 0 and 65535.');
  }
  return port;
}

/**
 * Creates the local API host from process-environment configuration.
 * Secrets stay in the host process and are never sent to browser code.
 */
export function createLocalApiHost({ env = process.env } = {}) {
  const profilePath = requiredEnv(env, 'BUILDBOOK_PROFILE_PATH');
  const accessToken = requiredEnv(env, 'BUILDBOOK_LOCAL_API_TOKEN');
  const host = String(env.BUILDBOOK_LOCAL_API_HOST || '127.0.0.1').trim();
  const port = readPort(env);
  const profileStore = createProfileStore(profilePath);
  const api = createLocalApiServer({ profileStore, accessToken, host, port });
  let address = null;
  let startPromise = null;
  let stopPromise = null;

  function start() {
    if (stopPromise) return stopPromise.then(start);
    if (address) return Promise.resolve(address);
    if (startPromise) return startPromise;
    startPromise = api.listen().then(value => {
      address = value;
      return value;
    }).finally(() => { startPromise = null; });
    return startPromise;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (startPromise) await startPromise.catch(() => {});
      await api.close();
      address = null;
    })().finally(() => { stopPromise = null; });
    return stopPromise;
  }

  return Object.freeze({
    start,
    stop,
    get running() { return address !== null; },
  });
}
