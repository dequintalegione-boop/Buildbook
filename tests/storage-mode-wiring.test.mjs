import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const serviceWorker = await readFile(new URL('../sw.js', import.meta.url), 'utf8');

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
  assert.match(serviceWorker, /const C='buildbook-48'/);
  assert.match(serviceWorker, /\.\/client\/canonical-profile-runtime\.mjs/);
  assert.match(serviceWorker, /\.\/host\/profile-repository-adapter\.mjs/);
  assert.match(serviceWorker, /keys\.filter\(k=>k!==C\)/);
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
