import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';

const MAX_BODY_BYTES = 34 * 1024 * 1024;
const SUPPORTED_PROFILE_SCHEMA_VERSION = 5;
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SESSION_COOKIE = 'buildbook_local_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 8;

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const LOCAL_ACTION_SCRIPTS = Object.freeze({
  'telegram-setup': Object.freeze({ file: 'setup-buildbook-telegram.bat', mode: 'detached' }),
  'telegram-manage': Object.freeze({ file: 'manage-buildbook-telegram.bat', mode: 'detached' }),
  'telegram-state': Object.freeze({ file: 'set-buildbook-telegram-state.bat', mode: 'detached' }),
  'host-autostart-install': Object.freeze({ file: 'install-buildbook-autostart.ps1', mode: 'run' }),
  'host-autostart-uninstall': Object.freeze({ file: 'uninstall-buildbook-autostart.ps1', mode: 'run' }),
});

async function launchWindowsLocalAction(action) {
  const definition = LOCAL_ACTION_SCRIPTS[action];
  if (!definition) {
    const error = new Error('Неизвестное локальное действие.');
    error.code = 'LOCAL_ACTION_NOT_ALLOWED';
    throw error;
  }
  if (process.platform !== 'win32') {
    const error = new Error('Локальные помощники Windows доступны только в Windows.');
    error.code = 'LOCAL_ACTION_UNSUPPORTED';
    throw error;
  }

  // Both the action and script path come from a fixed allowlist. No request
  // data is ever passed to PowerShell or cmd.exe.
  if (definition.mode === 'run') {
    const scriptPath = resolve(APP_ROOT, 'scripts', definition.file);
    const { stdout = '', stderr = '' } = await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ], {
      cwd: APP_ROOT,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 128 * 1024,
    });
    const output = [stdout, stderr].map(value => String(value || '').trim()).filter(Boolean).join('\\n').slice(0, 4000);
    return {
      ok: true,
      completed: true,
      message: 'Команда выполнена.',
      output,
    };
  }

  await execFileAsync('cmd.exe', ['/d', '/s', '/c', 'start "" "scripts\\' + definition.file + '"'], {
    cwd: APP_ROOT,
    windowsHide: true,
    timeout: 5000,
    windowsVerbatimArguments: false,
  });
  return { ok: true, completed: false, message: 'Интерактивный помощник открыт в отдельном окне.' };
}
const STATIC_ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/repository.js', ['repository.js', 'text/javascript; charset=utf-8']],
  ['/client/profile-export.js', ['client/profile-export.js', 'text/javascript; charset=utf-8']],
  ['/client/profile-import.js', ['client/profile-import.js', 'text/javascript; charset=utf-8']],
  ['/client/telegram-overrides.js', ['client/telegram-overrides.js', 'text/javascript; charset=utf-8']],
  ['/client/canonical-profile-runtime.mjs', ['client/canonical-profile-runtime.mjs', 'text/javascript; charset=utf-8']],
  ['/host/profile-repository-adapter.mjs', ['host/profile-repository-adapter.mjs', 'text/javascript; charset=utf-8']],
  ['/scripts/setup-buildbook-telegram.bat', ['scripts/setup-buildbook-telegram.bat', 'text/plain; charset=utf-8']],
  ['/scripts/setup-buildbook-telegram.ps1', ['scripts/setup-buildbook-telegram.ps1', 'text/plain; charset=utf-8']],
  ['/scripts/start-buildbook-local-host.bat', ['scripts/start-buildbook-local-host.bat', 'text/plain; charset=utf-8']],
  ['/scripts/start-buildbook-local-host.ps1', ['scripts/start-buildbook-local-host.ps1', 'text/plain; charset=utf-8']],
  ['/scripts/manage-buildbook-telegram.bat', ['scripts/manage-buildbook-telegram.bat', 'text/plain; charset=utf-8']],
  ['/scripts/manage-buildbook-telegram.ps1', ['scripts/manage-buildbook-telegram.ps1', 'text/plain; charset=utf-8']],
  ['/vendor/xlsx.full.min.js', ['vendor/xlsx.full.min.js', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
]);
const STATIC_CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

async function serveStaticAsset(response, pathname, method, staticRoot) {
  const asset = STATIC_ASSETS.get(pathname);
  if (!asset) return false;
  const [relativePath, contentType] = asset;
  const root = resolve(staticRoot);
  const absolutePath = resolve(root, relativePath);
  const fromRoot = relative(root, absolutePath);
  if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    response.writeHead(404, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end();
    return true;
  }
  try {
    const [rootReal, fileReal, details] = await Promise.all([
      realpath(root),
      realpath(absolutePath),
      lstat(absolutePath),
    ]);
    const realRelative = relative(rootReal, fileReal);
    if (details.isSymbolicLink() || !details.isFile() || !realRelative
      || realRelative.startsWith('..') || isAbsolute(realRelative) || details.size > 12 * 1024 * 1024) {
      response.writeHead(404, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end();
      return true;
    }
    const body = method === 'HEAD' ? null : await readFile(fileReal);
    response.writeHead(200, {
      'content-type': contentType,
      'content-length': details.size,
      'cache-control': pathname === '/sw.js' || pathname === '/' || pathname === '/index.html' ? 'no-cache' : 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
      'cross-origin-opener-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      'content-security-policy': STATIC_CSP,
    });
    if (body) response.end(body);
    else response.end();
  } catch {
    response.writeHead(404, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end();
  }
  return true;
}

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

function readJson(request, maxBytes = MAX_BODY_BYTES) {
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
      if (size > maxBytes) {
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

function readSessionCookie(request) {
  const entries = String(request.headers.cookie || '').split(';')
    .map(part => part.trim())
    .filter(part => part.startsWith(SESSION_COOKIE + '='));
  if (entries.length === 0) return { present: false, value: '' };
  if (entries.length !== 1) return { present: true, value: null };
  const value = entries[0].slice(SESSION_COOKIE.length + 1);
  return { present: true, value: /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null };
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
  // Requests without Origin are retained for non-browser clients. Browser
  // requests must match the exact local API origin, including its port.
  if (!origin) return true;
  try {
    const parsedOrigin = new URL(origin);
    const rawHost = String(request.headers.host || '');
    const requestUrl = new URL('http://' + rawHost);
    return parsedOrigin.protocol === 'http:'
      && !parsedOrigin.username && !parsedOrigin.password
      && parsedOrigin.pathname === '/' && !parsedOrigin.search && !parsedOrigin.hash
      && ALLOWED_HOSTS.has(parsedOrigin.hostname.toLowerCase())
      && requestUrl.pathname === '/'
      && parsedOrigin.host.toLowerCase() === requestUrl.host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Localhost-only HTTP API. Keep it bound to loopback; do not expose it to LAN.
 * Browser clients read/write the canonical profile through this API, never the file.
 */
export function createLocalApiServer({ profileStore, accessToken, getTelegramStatus, startTelegram, stopTelegram, verifyTelegramBot = null, configureTelegram = null, getTelegramMessages = null, getTelegramBotProfile = null, getTelegramCommands = null, setTelegramCommands = null, getTelegramAllowlist = null, setTelegramAllowlist = null, getHostRecoveryStatus = null, launchLocalAction = null, host = '127.0.0.1', port = 0, staticRoot = null, sessionTtlMs = SESSION_TTL_MS, now = Date.now } = {}) {
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1 || sessionTtlMs > SESSION_TTL_MS || typeof now !== 'function') {
    throw new TypeError('Срок браузерной сессии должен быть от 1 мс до 12 часов.');
  }
  if (typeof accessToken !== 'string' || Buffer.byteLength(accessToken, 'utf8') < 32
    || Buffer.byteLength(accessToken, 'utf8') > 4096) {
    throw new TypeError('Для локального API требуется секретный токен длиной от 32 до 4096 байт.');
  }
  if (!profileStore || typeof profileStore.read !== 'function' || typeof profileStore.write !== 'function') {
    throw new TypeError('Для локального API требуется profileStore.');
  }
  if (configureTelegram !== null && typeof configureTelegram !== 'function') {
    throw new TypeError('configureTelegram must be a function or null.');
  }
  if (getHostRecoveryStatus !== null && typeof getHostRecoveryStatus !== 'function') throw new TypeError('getHostRecoveryStatus must be a function or null.');
  if (getTelegramBotProfile !== null && typeof getTelegramBotProfile !== 'function') throw new TypeError('getTelegramBotProfile must be a function or null.');
  if (getTelegramCommands !== null && typeof getTelegramCommands !== 'function') throw new TypeError('getTelegramCommands must be a function or null.');
  if (setTelegramCommands !== null && typeof setTelegramCommands !== 'function') throw new TypeError('setTelegramCommands must be a function or null.');
  if (getTelegramAllowlist !== null && typeof getTelegramAllowlist !== 'function') throw new TypeError('getTelegramAllowlist must be a function or null.');
  if (setTelegramAllowlist !== null && typeof setTelegramAllowlist !== 'function') throw new TypeError('setTelegramAllowlist must be a function or null.');
  if (getTelegramMessages !== null && typeof getTelegramMessages !== 'function') {
    throw new TypeError('getTelegramMessages must be a function or null.');
  }
  if (verifyTelegramBot !== null && typeof verifyTelegramBot !== 'function') {
    throw new TypeError('verifyTelegramBot must be a function or null.');
  }
  if (launchLocalAction !== null && typeof launchLocalAction !== 'function') {
    throw new TypeError('launchLocalAction должен быть функцией или null.');
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
      // The app host serves a fixed allowlist only; API routes remain session-protected.
      if (staticRoot && !pathname.startsWith('/api/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
          response.end();
          return;
        }
        const decodedPath = decodeURIComponent(pathname);
        if (decodedPath !== pathname || pathname.includes('\\') || pathname.includes('\0')
          || pathname.split('/').some(segment => segment.startsWith('.') || segment === '..')) {
          response.writeHead(404, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          response.end();
          return;
        }
        if (await serveStaticAsset(response, pathname, request.method, staticRoot)) return;
        response.writeHead(404, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        response.end();
        return;
      }
    } catch {
      send(response, 400, { error: 'Некорректный адрес запроса.' });
      return;
    }

    const authorization = String(request.headers.authorization || '');
    const suppliedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const expected = Buffer.from(accessToken, 'utf8');
    const supplied = Buffer.from(suppliedToken, 'utf8');
    const tokenMatches = supplied.length === expected.length && timingSafeEqual(supplied, expected);

    // PWA/local-host pairing: when the UI is served by this very host,
    // same-origin possession is sufficient to establish its browser session.
    // This removes manual .env key copying without opening cross-origin access.
    if (request.method === 'POST' && pathname === '/api/session/bootstrap-local') {
      if (!staticRoot || !origin || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(request.headers['content-type'] || ''))) {
        send(response, 403, { error: 'Автоподключение доступно только из интерфейса, который раздаёт локальный хост.' });
        return;
      }
      try {
        const body = await readJson(request, 1024);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
          send(response, 400, { error: 'Запрос подключения должен содержать пустой JSON-объект.' });
          return;
        }
      } catch (error) {
        send(response, error.status || 400, { error: error.status ? error.message : 'Некорректный запрос подключения.' });
        return;
      }
      const previousCookie = readSessionCookie(request);
      if (previousCookie.present && previousCookie.value === null) {
        send(response, 400, { error: 'Заголовок браузерной сессии имеет неоднозначный формат.' });
        return;
      }
      if (previousCookie.value) sessions.delete(previousCookie.value);
      for (const [key, session] of sessions) if (session.expiresAt <= now()) sessions.delete(key);
      if (sessions.size >= MAX_SESSIONS) {
        send(response, 429, { error: 'Достигнут лимит активных браузерных подключений.' });
        return;
      }
      const sessionId = randomBytes(32).toString('base64url');
      sessions.set(sessionId, { expiresAt: now() + sessionTtlMs });
      response.setHeader('set-cookie', SESSION_COOKIE + '=' + sessionId + '; HttpOnly; SameSite=Strict; Path=/api; Max-Age=' + Math.ceil(sessionTtlMs / 1000));
      send(response, 200, { ok: true, expiresIn: sessionTtlMs, method: 'same-origin' });
      return;
    }

    // Exchange the host-only bootstrap secret for a short-lived HttpOnly
    // browser session. The session secret is never exposed to JavaScript or disk.
    if (request.method === 'POST' && pathname === '/api/session/bootstrap') {
      if (!origin || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(request.headers['content-type'] || ''))) {
        send(response, 403, { error: 'Для подключения требуется локальный браузерный Origin и JSON.' });
        return;
      }
      if (!tokenMatches) {
        send(response, 401, { error: 'Неверный ключ первоначального подключения.' });
        request.resume();
        return;
      }
      try {
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
          send(response, 400, { error: 'Запрос подключения должен содержать пустой JSON-объект.' });
          return;
        }
      } catch (error) {
        send(response, error.status || 400, { error: error.status ? error.message : 'Некорректный запрос подключения.' });
        return;
      }
      const previousCookie = readSessionCookie(request);
      if (previousCookie.present && previousCookie.value === null) {
        send(response, 400, { error: 'Заголовок браузерной сессии имеет неоднозначный формат.' });
        return;
      }
      if (previousCookie.value) sessions.delete(previousCookie.value);
      for (const [key, session] of sessions) if (session.expiresAt <= now()) sessions.delete(key);
      if (sessions.size >= MAX_SESSIONS) {
        send(response, 429, { error: 'Достигнут лимит активных браузерных подключений.' });
        return;
      }
      const sessionId = randomBytes(32).toString('base64url');
      sessions.set(sessionId, { expiresAt: now() + sessionTtlMs });
      response.setHeader('set-cookie', SESSION_COOKIE + '=' + sessionId + '; HttpOnly; SameSite=Strict; Path=/api; Max-Age=' + Math.ceil(sessionTtlMs / 1000));
      send(response, 200, { ok: true, expiresIn: sessionTtlMs });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/session/close') {
      if (!origin) {
        send(response, 403, { error: 'Для закрытия сессии требуется локальный браузерный Origin.' });
        return;
      }
      const cookie = readSessionCookie(request);
      if (cookie.value) sessions.delete(cookie.value);
      response.setHeader('set-cookie', SESSION_COOKIE + '=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0');
      send(response, 200, { ok: true });
      return;
    }

    const cookie = readSessionCookie(request);
    const sessionId = cookie.value || '';
    const session = sessions.get(sessionId);
    const sessionMatches = !!session && session.expiresAt > now();
    if (session && !sessionMatches) sessions.delete(sessionId);
    // The bootstrap bearer is a one-time exchange credential, not a reusable
    // API credential. All other routes require the HttpOnly browser session.
    if (!sessionMatches) {
      send(response, 401, { error: 'Требуется действующая сессия локального API.' });
      return;
    }
    const localActionPrefix = '/api/local-actions/';
    const localAction = pathname.startsWith(localActionPrefix) ? pathname.slice(localActionPrefix.length) : '';
    if (request.method === 'POST' && localAction) {
      const action = localAction;
      if (!Object.hasOwn(LOCAL_ACTION_SCRIPTS, action)) {
        send(response, 404, { error: 'Локальное действие не найдено.' });
        return;
      }
      try {
        const result = await (launchLocalAction || launchWindowsLocalAction)(action);
        const completed = result?.completed === true;
        send(response, completed ? 200 : 202, {
          ok: true,
          action,
          message: typeof result?.message === 'string' ? result.message : 'Локальный помощник запущен.',
          ...(typeof result?.output === 'string' && result.output ? { output: result.output.slice(0, 4000) } : {}),
        });
      } catch (error) {
        const unsupported = error?.code === 'LOCAL_ACTION_UNSUPPORTED';
        const details = [error?.stderr, error?.stdout, error?.message]
          .map(value => String(value || '').replace(/[\\r\\n\\t]+/g, ' ').trim())
          .filter(Boolean).join(' | ').slice(0, 800);
        send(response, unsupported ? 501 : 500, {
          error: unsupported
            ? 'Локальный помощник доступен только в Windows.'
            : details || 'Локальный помощник завершился с ошибкой. Проверьте журнал локального хоста.',
          code: unsupported ? 'LOCAL_ACTION_UNSUPPORTED' : 'LOCAL_ACTION_FAILED',
        });
      }
      return;
    }
    if (request.method === 'GET' && pathname === '/api/telegram/allowlist') {
      if (typeof getTelegramAllowlist !== 'function') {
        send(response, 503, { error: 'Управление списком доступа Telegram не подключено к локальному хосту.' });
        return;
      }
      try {
        const result = await getTelegramAllowlist();
        const users = Array.isArray(result?.users) ? result.users : [];
        send(response, 200, { users: users.filter(user => user && /^[1-9]\d{0,15}$/.test(String(user.id)))
          .map(user => ({ id: String(user.id), comment: typeof user.comment === 'string' ? user.comment.slice(0, 80) : '' })) });
      } catch {
        send(response, 500, { error: 'Не удалось загрузить список разрешённых Telegram-пользователей.' });
      }
      return;
    }
    if (request.method === 'PUT' && pathname === '/api/telegram/allowlist') {
      if (typeof setTelegramAllowlist !== 'function') {
        send(response, 503, { error: 'Управление списком доступа Telegram не подключено к локальному хосту.' });
        return;
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(request.headers['content-type'] || ''))) {
        send(response, 415, { error: 'Ожидается Content-Type: application/json.' });
        request.resume();
        return;
      }
      try {
        const body = await readJson(request, 16 * 1024);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
          || !Array.isArray(body.users) || body.users.length < 1 || body.users.length > 100) {
          send(response, 400, { error: 'Передайте от 1 до 100 разрешённых пользователей.' });
          return;
        }
        const users = [];
        const seen = new Set();
        for (const user of body.users) {
          if (!user || typeof user !== 'object' || Array.isArray(user)
            || Object.keys(user).some(key => !['id', 'comment'].includes(key))
            || typeof user.id !== 'string' || !/^[1-9]\d{0,15}$/.test(user.id)
            || (user.comment !== undefined && (typeof user.comment !== 'string' || user.comment.length > 80))) {
            send(response, 400, { error: 'Проверьте numeric user ID и комментарии (до 80 символов).' });
            return;
          }
          if (seen.has(user.id)) {
            send(response, 400, { error: 'В списке не должно быть повторяющихся Telegram user ID.' });
            return;
          }
          seen.add(user.id);
          users.push({ id: user.id, comment: user.comment || '' });
        }
        const result = await setTelegramAllowlist(users);
        send(response, 200, { ok: true, users: Array.isArray(result?.users) ? result.users : users });
      } catch (error) {
        send(response, 400, { error: typeof error?.message === 'string' && error.message.length <= 200
          ? error.message : 'Не удалось сохранить список доступа Telegram.' });
      }
      return;
    }
    if (request.method === 'GET' && pathname === '/api/health') {
      send(response, 200, { ok: true, service: 'buildbook-local-host' });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/diagnostics') {
      try {
        // Read through the same canonical store used by both browser and Telegram.
        // Only operational metadata is returned; never expose profile contents or paths.
        const stored = await profileStore.read();
        const rawTelegram = typeof getTelegramStatus === 'function' ? getTelegramStatus() : null;
        const queue = rawTelegram?.queue && typeof rawTelegram.queue === 'object' ? rawTelegram.queue : null;
        const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
        const timestamp = value => typeof value === 'string' && value.length <= 40 ? value : null;
        const lastCycleAt = timestamp(rawTelegram?.lastCycleAt);
        const lastCycleAgeMs = lastCycleAt && Number.isFinite(Date.parse(lastCycleAt))
          ? Math.max(0, Date.now() - Date.parse(lastCycleAt)) : null;
        send(response, 200, {
          ok: true,
          host: { status: 'online', nodeMajor: Number(process.versions.node.split('.')[0]) || null },
          profile: {
            status: stored?.profile && typeof stored.profile === 'object' ? 'ready' : 'empty',
            revision: Number.isSafeInteger(stored?.revision) && stored.revision >= 0 ? stored.revision : null,
          },
          telegram: {
            configured: rawTelegram?.enabled === true,
            running: rawTelegram?.running === true,
            lastCycleAt,
            lastCycleAgeMs,
            consecutiveFailures: count(rawTelegram?.consecutiveFailures),
            pending: count(queue?.pending),
            processing: count(queue?.processing),
            rejected: count(queue?.rejected),
            lastError: rawTelegram?.lastError ? {
              code: 'TELEGRAM_SERVICE_ERROR',
              at: timestamp(rawTelegram.lastError.at),
            } : null,
          },
          checkedAt: new Date().toISOString(),
        });
      } catch {
        send(response, 503, { ok: false, error: 'Не удалось проверить канонический профиль.' });
      }
      return;
    }
    if (request.method === 'POST' && (pathname === '/api/telegram/start' || pathname === '/api/telegram/stop')) {
      const action = pathname.endsWith('/start') ? startTelegram : stopTelegram;
      if (typeof action !== 'function') {
        send(response, 409, { error: 'Управление Telegram недоступно: сервис не настроен при запуске хоста.' });
        return;
      }
      try {
        await action();
        const raw = typeof getTelegramStatus === 'function' ? getTelegramStatus() : null;
        send(response, 200, { ok: true, running: raw?.running === true });
      } catch (error) {
        send(response, 409, { error: error?.message || 'Не удалось изменить состояние Telegram.' });
      }
      return;
    }
    if (request.method === 'GET' && pathname === '/api/host/recovery') {
      if (typeof getHostRecoveryStatus !== 'function') {
        send(response, 200, { supported: false, installed: false, state: 'unavailable', restartCount: 0, restartInterval: null });
        return;
      }
      try {
        send(response, 200, await getHostRecoveryStatus());
      } catch {
        send(response, 500, { error: 'Не удалось получить статус автовосстановления локального хоста.' });
      }
      return;
    }
    if (request.method === 'GET' && pathname === '/api/telegram/bot/profile') {
      if (typeof getTelegramBotProfile !== 'function') {
        send(response, 200, { bot: null });
        return;
      }
      try {
        const bot = await getTelegramBotProfile();
        send(response, 200, { bot: bot || null });
      } catch {
        send(response, 502, { error: 'Не удалось получить профиль Telegram-бота.' });
      }
      return;
    }
    if (request.method === 'GET' && pathname === '/api/telegram/commands') {
      if (typeof getTelegramCommands !== 'function') {
        send(response, 409, { error: 'Сначала подключите Telegram-бота.' });
        return;
      }
      try {
        const commands = await getTelegramCommands();
        if (!Array.isArray(commands) || commands.length > 100) throw new Error('Invalid command list.');
        send(response, 200, { commands });
      } catch {
        send(response, 502, { error: 'Не удалось получить команды бота из Telegram.' });
      }
      return;
    }
    if (request.method === 'POST' && pathname === '/api/telegram/commands') {
      if (typeof setTelegramCommands !== 'function') {
        send(response, 409, { error: 'Сначала подключите Telegram-бота.' });
        return;
      }
      const contentType = String(request.headers['content-type'] || '').trim().toLowerCase();
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(contentType)) {
        send(response, 415, { error: 'Ожидается Content-Type: application/json.' });
        request.resume();
        return;
      }
      try {
        const body = await readJson(request, 32 * 1024);
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).length !== 1 || !Array.isArray(body.commands) || body.commands.length > 100) {
          send(response, 400, { error: 'Передайте список команд бота.' });
          return;
        }
        await setTelegramCommands(body.commands);
        send(response, 200, { ok: true });
      } catch (error) {
        send(response, 400, { error: typeof error?.message === 'string' && error.message.length <= 200 ? error.message : 'Не удалось сохранить команды бота.' });
      }
      return;
    }
    if (request.method === 'GET' && pathname === '/api/telegram/messages') {
      if (typeof getTelegramMessages !== 'function') {
        send(response, 200, { messages: [] });
        return;
      }
      try {
        const messages = await getTelegramMessages();
        if (!Array.isArray(messages) || messages.length > 50) {
          send(response, 502, { error: 'Локальный журнал Telegram вернул некорректные данные.' });
          return;
        }
        send(response, 200, { messages });
      } catch {
        send(response, 500, { error: 'Не удалось прочитать журнал Telegram.' });
      }
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
        const payload = {
          enabled: raw?.enabled !== false,
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
        };
        if (typeof raw?.configured === 'boolean') payload.configured = raw.configured;
        send(response, 200, payload);
      } catch {
        send(response, 500, { error: 'Не удалось получить статус Telegram.' });
      }
      return;
    }
    if (request.method === 'POST' && pathname === '/api/telegram/setup') {
      if (typeof configureTelegram !== 'function') {
        send(response, 503, { error: 'Мастер настройки Telegram не подключён к локальному хосту.' });
        return;
      }
      const contentType = String(request.headers['content-type'] || '').trim().toLowerCase();
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(contentType)) {
        send(response, 415, { error: 'Ожидается Content-Type: application/json.' });
        request.resume();
        return;
      }
      try {
        const body = await readJson(request, 2048);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2
          || typeof body.token !== 'string' || body.token.length > 256 || !/^\d{1,16}:[A-Za-z0-9_-]{20,}$/.test(body.token)
          || typeof body.userId !== 'string' || !/^[1-9]\d{0,15}$/.test(body.userId)) {
          send(response, 400, { error: 'Проверьте токен бота и числовой Telegram user ID.' });
          return;
        }
        const bot = await configureTelegram({ token: body.token, userId: body.userId });
        if (!bot || typeof bot.id !== 'string' || typeof bot.firstName !== 'string') {
          send(response, 502, { error: 'Локальный хост вернул некорректный профиль бота.' });
          return;
        }
        send(response, 200, { ok: true, configured: true, enabled: false, running: false, bot });
      } catch (error) {
        send(response, error?.code === 'BUILD_BOOK_PROFILE_NOT_READY' ? 409 : 400, {
          error: typeof error?.message === 'string' && error.message.length <= 200
            ? error.message : 'Не удалось сохранить настройки Telegram.',
          code: typeof error?.code === 'string' ? error.code : 'TELEGRAM_SETUP_FAILED',
        });
      }
      return;
    }
    if (request.method === 'POST' && pathname === '/api/telegram/bot/verify') {
      if (typeof verifyTelegramBot !== 'function') {
        send(response, 503, { error: 'Проверка Telegram Bot API не настроена на локальном хосте.' });
        return;
      }
      const contentType = String(request.headers['content-type'] || '').trim().toLowerCase();
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(contentType)) {
        send(response, 415, { error: 'Ожидается Content-Type: application/json.' });
        request.resume();
        return;
      }
      try {
        const body = await readJson(request, 1024);
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).length !== 1 || typeof body.token !== 'string'
          || body.token.length > 256 || !/^\d{1,16}:[A-Za-z0-9_-]{20,}$/.test(body.token)) {
          send(response, 400, { error: 'Укажите корректный токен Telegram Bot API.' });
          return;
        }
        // The token exists only for this request. The callback must return a
        // sanitized bot profile; the token is never reflected in the response.
        const bot = await verifyTelegramBot(body.token);
        if (!bot || typeof bot.id !== 'string' || typeof bot.firstName !== 'string') {
          send(response, 502, { error: 'Telegram вернул некорректный профиль бота.' });
          return;
        }
        send(response, 200, { ok: true, bot });
      } catch (error) {
        send(response, 400, {
          error: typeof error?.message === 'string' && error.message.length <= 200
            ? error.message : 'Не удалось проверить токен Telegram.',
          code: typeof error?.code === 'string' ? error.code : 'TELEGRAM_BOT_VERIFY_FAILED',
        });
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
        const verified = await profileStore.read();
        const expectedReadback = createHash('sha256').update(JSON.stringify(importedProfile), 'utf8').digest('hex');
        const actualReadback = verified.profile && typeof verified.profile === 'object'
          ? createHash('sha256').update(JSON.stringify(verified.profile), 'utf8').digest('hex')
          : '';
        if (verified.revision !== revision || actualReadback !== expectedReadback) {
          send(response, 500, {
            error: 'Импорт записан, но контрольное чтение не подтвердило целостность профиля. Не повторяйте импорт; проверьте профиль и создайте резервную копию.',
            code: 'BUILD_BOOK_IMPORT_READBACK_FAILED',
            revision,
          });
          return;
        }
        send(response, 200, { revision, imported: true, verified: true });
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
