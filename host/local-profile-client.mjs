const DEFAULT_BASE_URL = 'http://127.0.0.1:43127';
const MAX_PROFILE_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_REQUEST_BYTES = 34 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch (_) {
    throw new Error('Локальный API должен иметь корректный адрес loopback.');
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Локальный API разрешён только по HTTP на localhost, 127.0.0.1 или ::1.');
  }
  return url.origin;
}

export function createLocalProfileClient({
  baseUrl = DEFAULT_BASE_URL,
  accessToken,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof accessToken !== 'string' || new TextEncoder().encode(accessToken).length < 32
    || new TextEncoder().encode(accessToken).length > 4096) {
    throw new Error('Для подключения к локальному профилю нужен API-токен длиной от 32 до 4096 байт.');
  }
  if (typeof fetchImpl !== 'function') throw new Error('Fetch API недоступен.');
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
    throw new RangeError('Тайм-аут локального API должен быть целым числом от 1 до 120000 мс.');
  }
  const base = normalizeBaseUrl(baseUrl);
  let sessionMode = false;
  let connectPromise = null;
  let closePromise = null;

  async function request(path, options = {}) {
    const controller = new AbortController();
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error('Local API request timed out');
        controller.abort(error);
        reject(error);
      }, requestTimeoutMs);
    });

    const operation = (async () => {
      const response = await fetchImpl(base + path, {
        ...options,
        signal: controller.signal,
        // Never forward the bearer token through redirects or ambient browser state.
        redirect: 'error',
        credentials: options.credentials || (sessionMode ? 'include' : 'omit'),
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: {
          ...(!sessionMode && accessToken ? { authorization: 'Bearer ' + accessToken } : {}),
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...(options.headers || {}),
        },
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        // Empty or non-JSON error bodies are handled by the HTTP status below.
      }
      return { response, payload };
    })();

    let result;
    try {
      result = await Promise.race([operation, timeoutPromise]);
    } catch (error) {
      const timedOut = controller.signal.aborted;
      const wrapped = new Error(timedOut
        ? 'Локальный сервис Buildbook не ответил за отведённое время.'
        : 'Локальный сервис Buildbook недоступен. Проверьте, запущен ли он.');
      wrapped.cause = error;
      wrapped.code = timedOut ? 'BUILD_BOOK_LOCAL_API_TIMEOUT' : 'BUILD_BOOK_LOCAL_API_UNAVAILABLE';
      throw wrapped;
    } finally {
      clearTimeout(timeout);
    }

    const { response, payload } = result;
    if (!response.ok) {
      const message = payload && typeof payload.error === 'string'
        ? payload.error
        : 'Локальный API вернул ошибку HTTP ' + response.status + '.';
      const error = new Error(message);
      error.status = response.status;
      error.code = payload && payload.code || (response.status === 409
        ? 'BUILD_BOOK_STORAGE_CONFLICT'
        : 'BUILD_BOOK_LOCAL_API_ERROR');
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

  return Object.freeze({
    async connectSession() {
      if ((sessionMode)) return true;
      if (connectPromise) return connectPromise;
      if (typeof accessToken !== 'string') {
        throw new Error('Для повторного подключения создайте новый клиент и введите ключ локального сервиса заново.');
      }
      connectPromise = (async () => {
        const result = await request('/api/session/bootstrap', {
          method: 'POST',
          body: '{}',
          credentials: 'include',
          headers: { authorization: 'Bearer ' + accessToken },
        });
        if (!result || result.ok !== true || result.expiresIn !== 12 * 60 * 60 * 1000) {
          throw new Error('Локальный сервис вернул некорректный результат подключения.');
        }
        // Drop the bootstrap secret after exchanging it for a browser-managed session.
        sessionMode = true;
        accessToken = null;
        return true;
      })();
      try {
        return await connectPromise;
      } finally {
        connectPromise = null;
      }
    },
    async closeSession() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        if (connectPromise) await connectPromise;
        if (!sessionMode) return false;
        const result = await request('/api/session/close', { method: 'POST' });
        if (!result || result.ok !== true) throw new Error('Не удалось закрыть сессию локального API.');
        sessionMode = false;
        return true;
      })();
      try {
        return await closePromise;
      } finally {
        closePromise = null;
      }
    },
    get connected() { return sessionMode; },
    async health() {
      const result = await request('/api/health');
      if (!result || result.ok !== true) throw new Error('Локальный сервис вернул некорректный ответ проверки состояния.');
      return result;
    },
    async telegramStatus() {
      const result = await request('/api/telegram/status');
      if (!result || typeof result.enabled !== 'boolean' || typeof result.running !== 'boolean'
        || !Number.isSafeInteger(result.lastProcessed) || result.lastProcessed < 0
        || !Number.isSafeInteger(result.consecutiveFailures) || result.consecutiveFailures < 0) {
        throw new Error('Локальный сервис вернул некорректный статус Telegram.');
      }
      return result;
    },
    async readProfile() {
      const result = await request('/api/profile');
      if (!result || !Number.isSafeInteger(result.revision) || result.revision < 0 ||
          !(result.profile === null || (typeof result.profile === 'object' && !Array.isArray(result.profile)))) {
        throw new Error('Локальный сервис вернул некорректный профиль.');
      }
      return result;
    },
    async importProfile(envelope, expectedRevision) {
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
        throw new TypeError('Для импорта нужен проверенный конверт файла переноса.');
      }
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision === Number.MAX_SAFE_INTEGER) {
        throw new Error('Для импорта нужна корректная ревизия целевого профиля.');
      }
      let body;
      try { body = JSON.stringify({ envelope, expectedRevision }); } catch {
        throw new TypeError('Файл переноса должен содержать только сериализуемые JSON-данные.');
      }
      if (typeof body !== 'string' || new TextEncoder().encode(body).byteLength > MAX_IMPORT_REQUEST_BYTES) {
        throw new RangeError('Размер запроса импорта превышает допустимые 34 MiB.');
      }
      const result = await request('/api/profile/import', { method: 'POST', body });
      if (!result || result.imported !== true || result.verified !== true || !Number.isSafeInteger(result.revision)
        || result.revision !== expectedRevision + 1) {
        throw new Error('Локальный сервис вернул некорректный результат импорта.');
      }
      return result.revision;
    },
    async writeProfile(profile, expectedRevision) {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        throw new TypeError('Профиль для сохранения должен быть объектом.');
      }
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision === Number.MAX_SAFE_INTEGER) {
        throw new Error('Для сохранения профиля нужна корректная ревизия.');
      }
      let body;
      try { body = JSON.stringify({ profile, expectedRevision }); } catch {
        throw new TypeError('Профиль должен содержать только сериализуемые JSON-данные.');
      }
      if (typeof body !== 'string' || new TextEncoder().encode(body).byteLength > MAX_PROFILE_REQUEST_BYTES) {
        throw new RangeError('Размер запроса профиля превышает допустимые 8 MiB.');
      }
      let result;
      try {
        result = await request('/api/profile', { method: 'PUT', body });
      } catch (cause) {
        // A lost response or server error may happen after the atomic commit.
        // Never blindly retry a financial write; force the caller to read current state.
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
      if (!result || typeof result !== 'object' || Array.isArray(result)
        || Object.keys(result).length !== 1 || !Object.hasOwn(result, 'revision')
        || !Number.isSafeInteger(result.revision) || result.revision !== expectedRevision + 1) {
        const error = new Error('Результат сохранения неизвестен: сервер не подтвердил новую ревизию. перечитайте профиль перед повторной попыткой.');
        error.code = 'BUILD_BOOK_SAVE_RESULT_UNKNOWN';
        throw error;
      }
      return result.revision;
    },
  });
}
