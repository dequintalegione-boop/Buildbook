import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';

const MAX_BODY_BYTES = 34 * 1024 * 1024;
const SUPPORTED_PROFILE_SCHEMA_VERSION = 5;
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SESSION_COOKIE = 'buildbook_local_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 8;

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    let tooLarge = false;
    const chunks = [];
    const fail = (message, status) => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error(message), { status }));
    };

    request.on('data', chunk => {
      if (tooLarge || settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        fail('Тело запроса превышает допустимый размер.', 413);
        // Drain the remaining request without retaining it; keep the socket alive
        // long enough for the caller to send the documented 413 response.
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      let parsed;
      try {
        const bytes = Buffer.concat(chunks);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        parsed = JSON.parse(text);
      } catch {
        fail('Ожидался корректный JSON.', 400);
        return;
      }
      settled = true;
      resolve(parsed);
    });
    request.on('aborted', () => {
      fail('Клиент прервал отправку запроса.', 400);
    });
    request.on('error', error => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

const ISO_EXPORT_DATE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function isValidExportDate(value) {
  if (typeof value !== 'string') return false;
  const match = ISO_EXPORT_DATE.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone, sign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const offsetHour = Number(offsetHourText || 0), offsetMinute = Number(offsetMinuteText || 0);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59
    || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, Number((fraction + '000').slice(0, 3)));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return false;
  return Number.isFinite(Date.parse(value)) && (sign === '+' || sign === '-' || zone === 'Z');
}

function requestHostAllowed(request) {
  const rawHost = String(request.headers.host || '').toLowerCase();
  const host = rawHost.startsWith('[')
    ? rawHost.slice(0, rawHost.indexOf(']') + 1)
    : rawHost.split(':')[0];
  const suffix = rawHost.startsWith('[')
    ? rawHost.slice(rawHost.indexOf(']') + 1)
    : (rawHost.includes(':') ? rawHost.slice(rawHost.indexOf(':')) : '');
  const portText = suffix.slice(1);
  const validPort = suffix === '' || (/^:\d{1,5}$/.test(suffix) && Number(portText) <= 65535);
  return validPort && ALLOWED_HOSTS.has(host);
}

function originAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !parsed.username && !parsed.password
      && parsed.pathname === '/' && !parsed.search && !parsed.hash
      && ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Localhost-only HTTP API. Keep it bound to loopback; do not expose it to LAN.
 * Browser clients read/write the canonical profile through this API, never the file.
 */
export function createLocalApiServer({ profileStore, accessToken, getTelegramStatus, host = '127.0.0.1', port = 0 } = {}) {
  if (typeof accessToken !== 'string' || Buffer.byteLength(accessToken, 'utf8') < 32
    || Buffer.byteLength(accessToken, 'utf8') > 4096) {
    throw new TypeError('Для локального API требуется секретный токен длиной от 32 до 4096 байт.');
  }
  if (!profileStore || typeof profileStore.read !== 'function' || typeof profileStore.write !== 'function') {
    throw new TypeError('Для локального API требуется profileStore.');
  }
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) || (isIP(host) === 0 && host !== 'localhost')) {
    throw new TypeError('Локальный API разрешено привязывать только к loopback-интерфейсу.');
  }

  const sessions = new Map();
  const server = createServer({ maxHeaderSize: 8 * 1024 }, async (request, response) => {
    if (!requestHostAllowed(request)) {
      send(response, 403, { error: 'Запрос отклонён: доступ разрешён только с локального интерфейса.' });
      return;
    }
    if (!originAllowed(request)) {
      send(response, 403, { error: 'Запрос отклонён: доступ разрешён только с локального интерфейса.' });
      return;
    }
    const origin = request.headers.origin;
    if (origin) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
      response.setHeader('access-control-allow-credentials', 'true');
    }
    if (request.method === 'OPTIONS') {
      if (!origin) {
        send(response, 403, { error: 'Для предварительного запроса требуется локальный Origin.' });
        return;
      }
      response.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type',
        'access-control-allow-credentials': 'true',
        'access-control-max-age': '600',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'cross-origin-resource-policy': 'same-origin',
        'cross-origin-opener-policy': 'same-origin',
        'permissions-policy': 'camera=(), microphone=(), geolocation=()',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
        'vary': 'Origin',
      });
      response.end();
      return;
    }

    let pathname;
    try {
      const requestUrl = new URL(request.url || '/', 'http://localhost');
      if (requestUrl.origin !== 'http://localhost' || requestUrl.search || requestUrl.hash) {
        send(response, 400, { error: 'Некорректный адрес запроса.' });
        return;
      }
      pathname = requestUrl.pathname;
    } catch {
      send(response, 400, { error: 'Некорректный адрес запроса.' });
      return;
    }

    const authorization = String(request.headers.authorization || '');
    const suppliedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const expected = Buffer.from(accessToken, 'utf8');
    const supplied = Buffer.from(suppliedToken, 'utf8');
    const tokenMatches = supplied.length === expected.length && timingSafeEqual(supplied, expected);

    // Exchange the host-only bootstrap secret for a short-lived HttpOnly
    // browser session. The session secret is never exposed to JavaScript or disk.
    if (request.method === 'POST' && pathname === '/api/session/bootstrap') {
      if (!origin || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(request.headers['content-type'] || ''))) {
        send(response, 403, { error: 'Для подключения требуется локальный браузерный Origin и JSON.' });
        return;
      }
      if (!tokenMatches) {
        send(response, 401, { error: 'Неверный ключ первоначального подключения.' });
        return;
      }
      for (const [key, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(key);
      if (sessions.size >= MAX_SESSIONS) {
        send(response, 429, { error: 'Достигнут лимит активных браузерных подключений.' });
        return;
      }
      const sessionId = randomBytes(32).toString('base64url');
      sessions.set(sessionId, { expiresAt: Date.now() + SESSION_TTL_MS });
      response.setHeader('set-cookie', SESSION_COOKIE + '=' + sessionId + '; HttpOnly; SameSite=Strict; Path=/api');
      send(response, 200, { ok: true, expiresIn: SESSION_TTL_MS });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/session/close') {
      if (!origin) {
        send(response, 403, { error: 'Для закрытия сессии требуется локальный браузерный Origin.' });
        return;
      }
      const cookie = String(request.headers.cookie || '').split(';').map(part => part.trim())
        .find(part => part.startsWith(SESSION_COOKIE + '='));
      if (cookie) sessions.delete(cookie.slice(SESSION_COOKIE.length + 1));
      response.setHeader('set-cookie', SESSION_COOKIE + '=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0');
      send(response, 200, { ok: true });
      return;
    }

    const cookie = String(request.headers.cookie || '').split(';').map(part => part.trim())
      .find(part => part.startsWith(SESSION_COOKIE + '='));
    const sessionId = cookie ? cookie.slice(SESSION_COOKIE.length + 1) : '';
    const session = sessions.get(sessionId);
    const sessionMatches = !!session && session.expiresAt > Date.now();
    if (session && !sessionMatches) sessions.delete(sessionId);
    if (!tokenMatches && !sessionMatches) {
      send(response, 401, { error: 'Требуется действующая сессия локального API.' });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/health') {
      send(response, 200, { ok: true, service: 'buildbook-local-host' });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/telegram/status') {
      if (typeof getTelegramStatus !== 'function') {
        send(response, 404, { error: 'Статус Telegram не подключён.' });
        return;
      }
      try {
        const raw = getTelegramStatus();
        const queue = raw?.queue && typeof raw.queue === 'object' ? raw.queue : null;
        const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
        const timestamp = value => typeof value === 'string' && value.length <= 40 ? value : null;
        send(response, 200, {
          running: raw?.running === true,
          startedAt: timestamp(raw?.startedAt),
          lastCycleAt: timestamp(raw?.lastCycleAt),
          lastProcessed: count(raw?.lastProcessed),
          consecutiveFailures: count(raw?.consecutiveFailures),
          queue: queue ? {
            total: count(queue.total),
            pending: count(queue.pending),
            processing: count(queue.processing),
            completed: count(queue.completed),
            rejected: count(queue.rejected),
          } : null,
          lastError: raw?.lastError ? {
            code: 'TELEGRAM_SERVICE_ERROR',
            message: 'Ошибка сервиса Telegram; подробности исключения не сохраняются.',
            at: timestamp(raw.lastError.at),
          } : null,
        });
      } catch {
        send(response, 500, { error: 'Не удалось получить статус Telegram.' });
      }
      return;
    }
    if (request.method === 'POST' && pathname === '/api/profile/import') {
      const declaredLength = request.headers['content-length'];
      if (declaredLength !== undefined && (!/^\d+$/.test(String(declaredLength)) || Number(declaredLength) > MAX_BODY_BYTES)) {
        send(response, Number(declaredLength) > MAX_BODY_BYTES ? 413 : 400, { error: 'Некорректный или слишком большой Content-Length.' });
        request.resume();
        return;
      }
      const contentType = String(request.headers['content-type'] || '').trim().toLowerCase();
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(contentType)) {
        send(response, 415, { error: 'Ожидается Content-Type: application/json.' });
        return;
      }
      try {
        const body = await readJson(request);
        const envelope = body?.envelope;
        const payload = envelope?.payload;
        const hasExactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
          && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
        const validExportDate = isValidExportDate(envelope?.exportedAt)
          && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(envelope.exportedAt)
          && Number.isFinite(Date.parse(envelope.exportedAt));
        if (!hasExactKeys(body, ['expectedRevision', 'envelope'])
          || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0
          || !hasExactKeys(envelope, ['format', 'version', 'sourceSchemaVersion', 'exportedAt', 'payload', 'sha256'])
          || envelope.format !== 'buildbook-profile-export' || envelope.version !== 1
          || envelope.sourceSchemaVersion !== SUPPORTED_PROFILE_SCHEMA_VERSION || !validExportDate
          || !hasExactKeys(payload, ['state', 'logs', 'photos'])
          || !payload.state || typeof payload.state !== 'object' || Array.isArray(payload.state)
          || !Array.isArray(payload.logs)
          || !payload.photos || typeof payload.photos !== 'object' || Array.isArray(payload.photos)
          || typeof envelope.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.sha256)) {
          send(response, 400, { error: 'Файл импорта имеет неподдерживаемый или некорректный формат.' });
          return;
        }
        const serializedPayload = JSON.stringify(payload);
        if (Buffer.byteLength(serializedPayload, 'utf8') > 32 * 1024 * 1024) {
          send(response, 413, { error: 'Данные профиля превышают допустимые 32 MiB.' });
          return;
        }
        const digest = createHash('sha256').update(serializedPayload, 'utf8').digest('hex');
        const suppliedDigest = Buffer.from(envelope.sha256, 'ascii');
        const expectedDigest = Buffer.from(digest, 'ascii');
        if (suppliedDigest.length !== expectedDigest.length || !timingSafeEqual(suppliedDigest, expectedDigest)) {
          send(response, 400, { error: 'Контрольная сумма файла импорта не совпадает.' });
          return;
        }
        const current = await profileStore.read();
        if (current.revision !== body.expectedRevision) {
          const error = Object.assign(new Error('Профиль уже изменён. Повторно проверьте целевой профиль перед импортом.'), {
            code: 'BUILD_BOOK_STORAGE_CONFLICT',
            expectedRevision: body.expectedRevision,
            currentRevision: current.revision,
          });
          throw error;
        }
        if (current.profile !== null) {
          send(response, 409, { error: 'Импорт разрешён только в пустой профиль. Сначала сохраните резервную копию и используйте отдельную процедуру восстановления.', code: 'BUILD_BOOK_IMPORT_TARGET_NOT_EMPTY' });
          return;
        }
        const importedProfile = { state: payload.state, logs: payload.logs, photos: payload.photos };
        const revision = await profileStore.write(importedProfile, body.expectedRevision);
        send(response, 200, { revision, imported: true });
      } catch (error) {
        if (error.code === 'BUILD_BOOK_STORAGE_CONFLICT') {
          send(response, 409, {
            error: error.message,
            code: error.code,
            expectedRevision: error.expectedRevision,
            currentRevision: error.currentRevision,
          });
          return;
        }
        send(response, error.status || 500, { error: error.status ? error.message : 'Не удалось импортировать профиль.' });
      }
      return;
    }
    if (request.method === 'GET' && pathname === '/api/profile') {
      try {
        send(response, 200, await profileStore.read());
      } catch {
        send(response, 500, { error: 'Не удалось прочитать профиль.' });
      }
      return;
    }
    if (request.method === 'PUT' && pathname === '/api/profile') {
      const declaredLength = request.headers['content-length'];
      if (declaredLength !== undefined && (!/^\d+$/.test(String(declaredLength)) || Number(declaredLength) > MAX_BODY_BYTES)) {
        send(response, Number(declaredLength) > MAX_BODY_BYTES ? 413 : 400, { error: 'Некорректный или слишком большой Content-Length.' });
        request.resume();
        return;
      }
      const contentType = String(request.headers['content-type'] || '').trim().toLowerCase();
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(contentType)) {
        send(response, 415, { error: 'Ожидается Content-Type: application/json.' });
        return;
      }
      try {
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0
          || !body.profile || typeof body.profile !== 'object' || Array.isArray(body.profile)) {
          send(response, 400, { error: 'Запрос должен содержать profile и корректный expectedRevision.' });
          return;
        }
        const revision = await profileStore.write(body.profile, body.expectedRevision);
        send(response, 200, { revision });
      } catch (error) {
        if (error.code === 'BUILD_BOOK_STORAGE_CONFLICT') {
          send(response, 409, {
            error: error.message,
            code: error.code,
            expectedRevision: error.expectedRevision,
            currentRevision: error.currentRevision,
          });
          return;
        }
        send(response, error.status || 500, { error: error.status ? error.message : 'Не удалось сохранить профиль.' });
      }
      return;
    }
    send(response, 404, { error: 'Маршрут не найден.' });
  });

  // Bound slow-client resource use even when the caller never finishes a request.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.timeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;

  return Object.freeze({
    server,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = error => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve(server.address());
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close(error => error ? reject(error) : resolve());
      });
    },
  });
}
