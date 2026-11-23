const DEFAULT_BASE_URL = 'http://127.0.0.1:43127';
const MAX_PROFILE_REQUEST_BYTES = 8 * 1024 * 1024;
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
} = {}) {
  if (typeof accessToken !== 'string' || new TextEncoder().encode(accessToken).length < 32
    || new TextEncoder().encode(accessToken).length > 4096) {
    throw new Error('Для подключения к локальному профилю нужен API-токен длиной от 32 до 4096 байт.');
  }
  if (typeof fetchImpl !== 'function') throw new Error('Fetch API недоступен.');
  const base = normalizeBaseUrl(baseUrl);

  async function request(path, options = {}) {
    let response;
    try {
      response = await fetchImpl(base + path, {
        ...options,
        // The bearer token must never follow a redirect or accompany ambient
        // cookies/referrer data to another origin.
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: {
          authorization: 'Bearer ' + accessToken,
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      const wrapped = new Error('Локальный сервис Buildbook недоступен. Проверьте, запущен ли он.');
      wrapped.cause = error;
      wrapped.code = 'BUILD_BOOK_LOCAL_API_UNAVAILABLE';
      throw wrapped;
    }
    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) {
      const message = payload && typeof payload.error === 'string' ? payload.error : 'Локальный API вернул ошибку HTTP ' + response.status + '.';
      const error = new Error(message);
      error.status = response.status;
      error.code = payload && payload.code || (response.status === 409 ? 'BUILD_BOOK_STORAGE_CONFLICT' : 'BUILD_BOOK_LOCAL_API_ERROR');
      throw error;
    }
    return payload;
  }

  return Object.freeze({
    async health() {
      const result = await request('/api/health');
      if (!result || result.ok !== true) throw new Error('Локальный сервис вернул некорректный ответ проверки состояния.');
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
    async writeProfile(profile, expectedRevision) {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        throw new TypeError('Профиль для сохранения должен быть объектом.');
      }
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error('Для сохранения профиля нужна корректная ревизия.');
      }
      let body;
      try { body = JSON.stringify({ profile, expectedRevision }); } catch {
        throw new TypeError('Профиль должен содержать только сериализуемые JSON-данные.');
      }
      if (typeof body !== 'string' || new TextEncoder().encode(body).byteLength > MAX_PROFILE_REQUEST_BYTES) {
        throw new RangeError('Размер запроса профиля превышает допустимые 8 MiB.');
      }
      const result = await request('/api/profile', {
        method: 'PUT',
        body,
      });
      if (!result || !Number.isSafeInteger(result.revision) || result.revision !== expectedRevision + 1) {
        throw new Error('Локальный сервис вернул некорректную ревизию после сохранения.');
      }
      return result.revision;
    },
  });
}
