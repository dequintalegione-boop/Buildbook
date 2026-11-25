/* Buildbook service worker.
 * Cache name must be bumped whenever index.html or app shell changes,
 * otherwise browsers keep serving a stale shell (cache-first).
 */
const C = 'buildbook-53';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './repository.js',
  './vendor/xlsx.full.min.js',
  './client/canonical-profile-runtime.mjs',
  './host/profile-repository-adapter.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(C).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== C).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

function isAppShell(request, url) {
  if (request.mode === 'navigate') return true;
  const path = url.pathname;
  return path === '/' || path.endsWith('/index.html') || path.endsWith('/sw.js');
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (isAppShell(event.request, url)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(C).then((cache) => cache.put(event.request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.open(C).then((cache) => cache.match(event.request)).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.open(C).then((cache) =>
      cache.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response && response.ok) {
            cache.put(event.request, response.clone()).catch(() => {});
          }
          return response;
        });
      })
    )
  );
});
