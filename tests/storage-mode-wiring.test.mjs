import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const serviceWorker = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const localHostStartup = await readFile(new URL('../scripts/start-buildbook-local-host.ps1', import.meta.url), 'utf8');
const safeUpdater = await readFile(new URL('../scripts/apply-buildbook-update.ps1', import.meta.url), 'utf8');
const telegramOverrides = await readFile(new URL('../client/telegram-overrides.js', import.meta.url), 'utf8');

test('canonical storage is opt-in and ordinary IndexedDB remains the default', () => {
  assert.match(html, /const STORAGE_MODE_KEY='buildbook\.storage-mode'/);
  assert.match(html, /let STORAGE_MODE='indexeddb'/);
  assert.match(html, /!TEST_MODE&&location\.protocol==='http:'&&localStorage\.getItem\(STORAGE_MODE_KEY\)==='canonical'/);
  assert.match(html, /let repository=window\.BuildbookRepository\.create\(DB_NAME\)/);
});

test('canonical startup verifies the session and refuses an empty profile without IndexedDB fallback', () => {
  const start = html.indexOf('async function initializeCanonicalStorage()');
  const end = html.indexOf('APP_READY=(async()=>', start);
  assert.ok(start >= 0 && end > start);
  const block = html.slice(start, end);
  assert.match(block, /import\('\.\/client\/canonical-profile-runtime\.mjs'\)/);
  assert.match(block, /await canonicalRuntime\.verifySession\(\)/);
  assert.match(block, /repository=canonicalRuntime\.repository/);
  assert.match(block, /if\(!canonical\.state\)throw new Error/);
  assert.doesNotMatch(block, /BuildbookRepository\.create\(DB_NAME\)/);
  assert.match(html.slice(end, end + 700), /await initializeCanonicalStorage\(\);\s*await load\(\)/);
});

test('canonical mode is selected only after verified import and explicit user confirmation', () => {
  const importAt = html.indexOf('const actual=await window.BuildbookProfileExport.createEnvelope');
  const switchAt = html.indexOf("localStorage.setItem(STORAGE_MODE_KEY,'canonical')");
  assert.ok(importAt >= 0 && switchAt > importAt);
  const beforeSwitch = html.slice(importAt, switchAt);
  assert.match(beforeSwitch, /readback\.revision/);
  assert.match(beforeSwitch, /actual\.sha256!==verified\.sha256/);
  assert.match(beforeSwitch, /if\(confirm\('Переключить Buildbook на проверенный файловый профиль сейчас/);
});

test('canonical save failures stop editing and never silently continue on IndexedDB', () => {
  assert.match(html, /if\(STORAGE_MODE==='canonical'&&error&&error\.code!=='BUILD_BOOK_STORAGE_CONFLICT'\)/);
  assert.match(html, /if\(STORAGE_MODE==='canonical'&&APP_FATAL_ERROR\)return/);
  assert.match(html, /STORAGE_MODE==='canonical'&&\(error\.status===401\|\|error\.code==='BUILD_BOOK_LOCAL_API_UNAVAILABLE'\)/);
  assert.match(html, /data-a="storage-indexeddb"/);
  assert.match(html, /Автоматического перехода на другое хранилище не будет/);
});

test('closing the session is blocked while canonical profile is active', () => {
  const start = html.indexOf('async function closeTelegramSession()');
  const end = html.indexOf('function telegram()', start);
  assert.ok(start >= 0 && end > start);
  assert.match(html.slice(start, end), /if\(STORAGE_MODE==='canonical'\)/);
});

test('service worker precaches the canonical runtime dependency chain and rotates its cache', () => {
  assert.match(serviceWorker, /const C = 'buildbook-\d+'/);
  assert.match(serviceWorker, /\.\/client\/canonical-profile-runtime\.mjs/);
  assert.match(serviceWorker, /\.\/host\/profile-repository-adapter\.mjs/);
  assert.match(serviceWorker, /keys\.filter\(\(?\w+\)?\s*=>\s*\w+\s*!==\s*C\)/);
});

test('canonical revision conflicts lock the UI and preserve a backup path', () => {
  const start = html.indexOf('function markStorageConflict(revision)');
  const end = html.indexOf("if(storageChannel)storageChannel.addEventListener", start);
  assert.ok(start >= 0 && end > start);
  const conflict = html.slice(start, end);
  assert.match(conflict, /if\(STORAGE_MODE==='canonical'\)/);
  assert.match(conflict, /APP_FATAL_ERROR=new Error/);
  assert.match(conflict, /storageConflict=true;clearTimeout\(tm\)/);
  assert.match(html, /const save=\(\)=>\{\s*if\(APP_FATAL_ERROR\)return/);
  assert.match(html, /Скачать резервную копию текущего состояния/);
});


test('expired canonical sessions can be reconnected without accepting stale in-memory state', () => {
  assert.match(html, /function telegramConnectForm/);
  assert.match(html, /const base=location\.origin/);
  assert.match(html, /const latest=await runtime\.client\.readProfile\(\)/);
  assert.match(html, /canonicalReconnectReady=true/);
  assert.match(html, /data-a="tgconnect">Повторно подключить хост/);
  assert.match(html, /data-a="canonical-reload">Загрузить актуальный профиль/);
  assert.match(html, /несохранённые изменения этой вкладки не будут перенесены/);
  assert.match(html, /if\(STARTUP_STAGE==='ready'&&!confirm\(/);
});


test('canonical save recovery exposes 20 explicit safety contracts', async t => {
  await t.test("unknown outcome is classified explicitly", () => assert.match(html, /const unknown=error\.code==='BUILD_BOOK_SAVE_RESULT_UNKNOWN'/));
  await t.test("unknown outcome warns against blind retry", () => assert.match(html, /Не повторяйте сохранение вслепую/));
  await t.test("unknown outcome offers a fresh profile read", () => assert.match(html, /загрузите актуальный профиль/));
  await t.test("unknown outcome preserves backup action", () => assert.match(html, /Скачайте резервную копию текущего состояния/));
  await t.test("canonical failure remains fatal", () => assert.match(html, /APP_FATAL_ERROR=new Error/));
  await t.test("fatal canonical state blocks save entry", () => assert.match(html, /if\(STORAGE_MODE==='canonical'&&APP_FATAL_ERROR\)return/));
  await t.test("canonical errors do not silently fall back", () => assert.match(html, /Автоматического перехода на другое хранилище не будет/));
  await t.test("backup action is wired to export", () => assert.match(html, /data-a="expzip"/));
  await t.test("reconnect action remains available", () => assert.match(html, /data-a="tgconnect"/));
  await t.test("fresh profile reload is gated", () => assert.match(html, /canonicalReconnectReady\?'<button class="btn p" data-a="canonical-reload"/));
  await t.test("reload warns about lost unsaved edits", () => assert.match(html, /несохранённые изменения этой вкладки не будут перенесены/));
  await t.test("reload requires backup confirmation", () => assert.match(html, /Перед перезагрузкой скачайте резервную копию текущего состояния/));
  await t.test("revision conflict remains a separate path", () => assert.match(html, /error\.code==='BUILD_BOOK_STORAGE_CONFLICT'/));
  await t.test("conflict updates remote revision", () => assert.match(html, /markStorageConflict\(error\.currentRevision\)/));
  await t.test("conflict clears pending debounce", () => assert.match(html, /storageConflict=true;clearTimeout\(tm\)/));
  await t.test("conflict blocks queued writes", () => assert.match(html, /if\(storageConflict\|\|\(STORAGE_MODE==='canonical'&&APP_FATAL_ERROR\)\)return false/));
  await t.test("fatal screen states that in-memory data remains", () => assert.match(html, /Данные в памяти не удаляются/));
  await t.test("unknown result has its own user-facing copy", () => assert.match(html, /Результат сохранения неизвестен/));
  await t.test("storage switch remains explicit", () => assert.match(html, /data-a="storage-indexeddb"/));
  await t.test("canonical storage keeps host recovery guidance", () => assert.match(html, /проверьте локальный хост/));
});


test('Telegram UI overrides do not replace the single in-app local-host connection flow', () => {
  assert.doesNotMatch(telegramOverrides, /function telegramConnectForm/);
  assert.match(telegramOverrides, /async function telegramAllowlistEditor/);
  assert.match(telegramOverrides, /data-a="tgallowlist"/);
  assert.match(telegramOverrides, /id="tg-allowlist-panel"/);
  assert.match(telegramOverrides, /insertAdjacentHTML\('beforeend'/);
  assert.match(telegramOverrides, /method:'PUT'/);
  assert.doesNotMatch(telegramOverrides, /modal\('Белый список'/);
  assert.match(html, /function telegramConnectForm/);
  assert.match(html, /bootstrap-local/);
  assert.match(html, /Важное ограничение Windows/);
  assert.equal(html.includes('github.com/dequintalegione-boop/Buildbook/blob/main/scripts'), false);
});


test('every static data-a action is wired to the dispatcher or the explicit allowlist handler', () => {
  const start = html.indexOf('function act(a,id){const A={');
  const end = html.indexOf('A[a]&&A[a]()', start);
  assert.ok(start >= 0 && end > start);
  const dispatcher = html.slice(start, end);
  const keys = new Set([...dispatcher.matchAll(/(?:'([^'\n]{1,80})'|([A-Za-z_$][A-Za-z0-9_$-]*))\s*:/g)].map(match => match[1] || match[2]));
  const actions = [...html.matchAll(/\bdata-a\s*=\s*["']([^"']+)["']/g)].map(match => match[1]).filter(action => !action.includes('${'));
  const missing = [...new Set(actions)].filter(action => !keys.has(action) && action !== 'tgallowlist');
  assert.deepEqual(missing, []);
  assert.match(telegramOverrides, /data-a="tgallowlist"/);
});

test('local PWA pairing does not ask for a host key and explains the secret only for troubleshooting', () => {
  const start = html.indexOf('function telegramConnectForm()');
  const end = html.indexOf('async function closeTelegramSession()', start);
  const connector = html.slice(start, end);
  assert.match(connector, /const body=localOrigin/);
  assert.doesNotMatch(connector, /fld\('token'/);
  assert.match(connector, /BUILDBOOK_LOCAL_API_TOKEN/);
  assert.match(connector, /bootstrap-local/);
});

test('first local-host launch replaces a copied public placeholder API secret', () => {
  assert.match(localHostStartup, /REPLACE_/);
  assert.match(localHostStartup, /randomBytes\(32\)/);
  assert.match(localHostStartup, /Секрет локального API автоматически создан/);
  assert.doesNotMatch(localHostStartup, /Read-Host/);
});


test('Telegram setup and command editor actions have concrete in-app implementations', () => {
  assert.ok(html.includes('async function telegramCommandsEditor()'));
  assert.ok(html.includes('function telegramSetupWizard()'));
  assert.ok(html.includes("localTelegramRequest('/api/telegram/bot/verify'"));
  assert.ok(html.includes("localTelegramRequest('/api/telegram/setup'"));
  assert.ok(html.includes("localTelegramRequest('/api/telegram/commands'"));
});


test('Telegram dashboard loads the persistent action journal with status and safe event text', () => {
  assert.ok(html.includes("localTelegramRequest('/api/activity')"));
  assert.ok(html.includes('const actionEvents=Array.isArray(TELEGRAM_UI.activity)'));
  assert.ok(html.includes('Журнал действий'));
  assert.ok(html.includes('actionEvents.map'));
});


test('production Telegram UI does not display a developer revision marker', () => {
  assert.equal(telegramOverrides.includes('UI-rev 54'), false);
  assert.equal(telegramOverrides.includes('bb-ui-rev'), false);
});


test('Telegram setup wizard checks canonical profile before asking for the bot token', () => {
  const start = html.indexOf('async function telegramSetupWizard()');
  const end = html.indexOf('async function closeTelegramSession()', start);
  const wizard = html.slice(start, end);
  assert.match(wizard, /STORAGE_MODE!=='canonical'/);
  assert.match(wizard, /localTelegramRequest\('\/api\/profile'\)/);
  assert.match(wizard, /Локальный файловый профиль пока пуст/);
  assert.ok(wizard.indexOf('/api/profile') < wizard.indexOf('const tokenBody='));
});


test('Windows local host startup restricts .env access to the current account', () => {
  assert.match(localHostStartup, /whoami\.exe/);
  assert.match(localHostStartup, /icacls\.exe/);
  assert.match(localHostStartup, /\/reset/);
  assert.match(localHostStartup, /\/inheritancelevel:r/);
  assert.match(localHostStartup, /\/grant:r/);
  assert.match(localHostStartup, /не будет запущен с небезопасными правами/);
});


test('update controls renew an expired local-host session and install updates with one click', () => {
  const start = html.indexOf('async function getBuildbookUpdateStatus()');
  const end = html.indexOf('function sets()', start);
  assert.ok(start >= 0 && end > start);
  const updater = html.slice(start, end);
  assert.ok(updater.includes("const statusUrl='/api/updates/status'"));
  assert.ok(html.includes("cache:'no-store'"));
  assert.ok(updater.includes('localTelegramRequest(statusUrl'));
  assert.ok(updater.includes('if(error.status!==401)throw error'));
  assert.ok(updater.includes("localTelegramRequest('/api/session/bootstrap-local'"));
  assert.ok(updater.includes('async function installBuildbookUpdate()'));
  assert.ok(updater.includes("localTelegramRequest('/api/updates/install'"));
  assert.ok(updater.includes("method:'POST',body:'{}'"));
  assert.ok(updater.includes('timeoutMs:110000'));
  assert.ok(updater.includes('async function waitForBuildbookRestart(expectedCommit)'));
  assert.ok(updater.includes('sawHostStop'));
  assert.ok(updater.includes('/api/health?update_probe='));
  assert.ok(updater.includes('caches.keys'));
  assert.ok(serviceWorker.includes("const C = 'buildbook-77'"));
  const apiBypass = serviceWorker.indexOf("if (url.pathname.startsWith('/api/'))");
  const fetchHandler = serviceWorker.indexOf("self.addEventListener('fetch'");
  const cacheHandler = serviceWorker.indexOf('caches.open(C).then((cache)', fetchHandler);
  assert.ok(apiBypass >= 0 && apiBypass < cacheHandler);
  assert.ok(updater.includes('status.installedCommit===expectedCommit'));
  assert.equal(updater.includes("location.assign('/api/updates/download')"), false);
  assert.ok(html.includes('Установить обновление'));
});

test('safe updater stages the pinned archive, preserves user data and can roll back', () => {
  assert.ok(safeUpdater.includes('https://github.com/dequintalegione-boop/Buildbook/archive/'));
  assert.ok(safeUpdater.includes('Expand-VerifiedArchive'));
  assert.ok(safeUpdater.includes('ExternalAttributes'));
  assert.ok(safeUpdater.includes('$ReadyFile'));
  assert.ok(safeUpdater.includes('$readySignaled = $true'));
  assert.ok(safeUpdater.includes('buildbook-install.json'));
  assert.ok(safeUpdater.includes('backup-'));
  assert.ok(safeUpdater.includes("'/MIR'"));
  assert.ok(safeUpdater.includes("'/XD', '.git', 'node_modules', 'data', 'updates'"));
  assert.ok(safeUpdater.includes("'/XF', '.env', 'local-host.log', '*.tmp'"));
  assert.ok(safeUpdater.includes('Выполняю откат к резервной копии'));
  assert.ok(safeUpdater.includes('Wait-BuildbookHost'));
});
