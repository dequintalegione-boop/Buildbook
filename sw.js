/* Buildbook service worker — buildbook-53
 * Network-first shell; injects telegram-overrides.js into HTML so UI updates
 * reach clients even when index.html on disk is an older shell.
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
  './client/telegram-overrides.js',
];

const OVERRIDES_TAG = '<script src="client/telegram-overrides.js"></script>';

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

function isHtmlShell(request, url) {
  if (request.mode === 'navigate') return true;
  const path = url.pathname;
  return path === '/' || path.endsWith('/index.html');
}

async function withOverrides(response) {
  try {
    const ctype = response.headers.get('content-type') || '';
    if (!ctype.includes('text/html')) return response;
    let html = await response.text();
    if (!html.includes('telegram-overrides.js')) {
      if (html.includes('</body>')) html = html.replace('</body>', OVERRIDES_TAG + '\n</body>');
      else html += '\n' + OVERRIDES_TAG + '\n';
    }
    return new Response(html, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch {
    return response;
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (isHtmlShell(event.request, url) || url.pathname.endsWith('/sw.js')) {
    event.respondWith(
      fetch(event.request)
        .then(async (response) => {
          if (!response || !response.ok) throw new Error('network');
          const finalResponse = isHtmlShell(event.request, url) ? await withOverrides(response) : response;
          const copy = finalResponse.clone();
          caches.open(C).then((cache) => cache.put(event.request, copy)).catch(() => {});
          return finalResponse;
        })
        .catch(() =>
          caches.open(C).then((cache) =>
            cache.match(event.request).then(async (cached) => {
              if (!cached) return caches.match('./index.html');
              if (isHtmlShell(event.request, url)) return withOverrides(cached);
              return cached;
            })
          )
        )
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
