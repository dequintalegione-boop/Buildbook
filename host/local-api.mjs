import { createServer } from 'node:http';
import { isIP } from 'node:net';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
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
      try {
        settled = true;
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        fail('Ожидался корректный JSON.', 400);
      }
    });
    request.on('error', error => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function requestHostAllowed(request) {
  const rawHost = String(request.headers.host || '').toLowerCase();
  const host = rawHost.startsWith('[') ? rawHost.slice(0, rawHost.indexOf(']') + 1) : rawHost.split(':')[0];
  return ALLOWED_HOSTS.has(host);
}

function originAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Localhost-only HTTP API. Keep it bound to loopback; do not expose it to LAN.
 * Browser clients read/write the canonical profile through this API, never the file.
 */
export function createLocalApiServer({ profileStore, host = '127.0.0.1', port = 0 } = {}) {
  if (!profileStore || typeof profileStore.read !== 'function' || typeof profileStore.write !== 'function') {
    throw new TypeError('Для локального API требуется profileStore.');
  }
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) || (isIP(host) === 0 && host !== 'localhost')) {
    throw new TypeError('Локальный API разрешено привязывать только к loopback-интерфейсу.');
  }

  const server = createServer(async (request, response) => {
    if (!requestHostAllowed(request) || !originAllowed(request)) {
      send(response, 403, { error: 'Запрос отклонён: доступ разрешён только с локального интерфейса.' });
      return;
    }

    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (request.method === 'GET' && pathname === '/api/health') {
      send(response, 200, { ok: true, service: 'buildbook-local-host' });
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
      if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
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
