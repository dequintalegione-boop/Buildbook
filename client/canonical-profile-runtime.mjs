import { createProfileRepositoryAdapter } from '../host/profile-repository-adapter.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(String(value || 'http://127.0.0.1:43127')); } catch {
    throw new TypeError('Укажите корректный адрес локального API.');
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('Каноническое хранилище разрешено только через HTTP на loopback-адресе без пути и параметров.');
  }
  return url.origin;
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Creates a session-cookie-only browser repository for the canonical profile.
 * It deliberately has no IndexedDB fallback and never accepts a bearer token.
 * The caller must first complete the explicit local-host session bootstrap.
 */
export function createCanonicalProfileRuntime({
  baseUrl = 'http://127.0.0.1:43127',
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const base = normalizeBaseUrl(baseUrl);
  if (typeof fetchImpl !== 'function') throw new TypeError('Fetch API недоступен.');
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError('Тайм-аут локального API должен быть от 1 до 120000 мс.');
  }

  async function request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const cause = new Error('Local API request timed out');
        controller.abort(cause);
        reject(cause);
      }, requestTimeoutMs);
    });
    const operation = (async () => {
      const response = await fetchImpl(base + path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        credentials: 'include',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch (cause) {
        if (controller.signal.aborted) throw cause;
      }
      return { response, payload };
    })();
    let result;
    try {
      result = await Promise.race([operation, timeoutPromise]);
    } catch (cause) {
      const timedOut = controller.signal.aborted;
      const error = new Error(timedOut
        ? 'Локальный сервис Buildbook не ответил за отведённое время.'
        : 'Локальный сервис Buildbook недоступен или сессия не может быть использована.');
      error.code = timedOut
        ? 'BUILD_BOOK_LOCAL_API_TIMEOUT'
        : 'BUILD_BOOK_LOCAL_API_UNAVAILABLE';
      error.cause = cause;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    const { response, payload } = result;
    if (!response.ok) {
      const error = new Error(typeof payload?.error === 'string'
        ? payload.error
        : 'Локальный API вернул ошибку HTTP ' + response.status + '.');
      error.status = response.status;
      error.code = typeof payload?.code === 'string'
        ? payload.code
        : response.status === 401
          ? 'BUILD_BOOK_LOCAL_API_UNAUTHORIZED'
          : response.status === 409
            ? 'BUILD_BOOK_STORAGE_CONFLICT'
            : 'BUILD_BOOK_LOCAL_API_ERROR';
      if (Number.isSafeInteger(payload?.expectedRevision) && payload.expectedRevision >= 0) {
        error.expectedRevision = payload.expectedRevision;
      }
      if (Number.isSafeInteger(payload?.currentRevision) && payload.currentRevision >= 0) {
        error.currentRevision = payload.currentRevision;
      }
      throw error;
    }
    return payload;
  }

  const client = Object.freeze({
    async health() {
      const result = await request('/api/health');
      if (!result || result.ok !== true) throw new Error('Локальный API не подтвердил готовность.');
      return result;
    },
    async readProfile() {
      const result = await request('/api/profile');
      if (!isPlainRecord(result) || !Number.isSafeInteger(result.revision) || result.revision < 0
        || !(result.profile === null || isPlainRecord(result.profile))) {
        throw new Error('Локальный API вернул некорректный профиль.');
      }
      return result;
    },
    async writeProfile(profile, expectedRevision) {
      if (!isPlainRecord(profile)) throw new TypeError('Для сохранения нужен объект канонического профиля.');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
        || expectedRevision === Number.MAX_SAFE_INTEGER) {
        throw new TypeError('Для сохранения нужна корректная ревизия профиля.');
      }
      let result;
      try {
        result = await request('/api/profile', {
          method: 'PUT',
          body: { expectedRevision, profile },
        });
      } catch (cause) {
        if (cause?.code === 'BUILD_BOOK_LOCAL_API_TIMEOUT'
          || cause?.code === 'BUILD_BOOK_LOCAL_API_UNAVAILABLE'
          || (Number.isInteger(cause?.status) && cause.status >= 500)) {
          const error = new Error('Результат сохранения неизвестен: перечитайте профиль перед повторной попыткой.');
          error.code = 'BUILD_BOOK_SAVE_RESULT_UNKNOWN';
          error.cause = cause;
          throw error;
        }
        throw cause;
      }
      if (!isPlainRecord(result)
        || Object.keys(result).length !== 1
        || !Object.hasOwn(result, 'revision')
        || !Number.isSafeInteger(result.revision)
        || result.revision !== expectedRevision + 1) {
        const error = new Error('Результат сохранения неизвестен: сервер не подтвердил новую ревизию. Перечитайте профиль перед повторной попыткой.');
        error.code = 'BUILD_BOOK_SAVE_RESULT_UNKNOWN';
        throw error;
      }
      return result.revision;
    },
  });

  return Object.freeze({
    baseUrl: base,
    client,
    repository: createProfileRepositoryAdapter(client),
    async verifySession() {
      // Reading the profile is the authenticated check; /health alone is not.
      await client.readProfile();
      return true;
    },
  });
}
