/* Buildbook service worker — buildbook-64
 * Network-first shell. Injects telegram-overrides.js only at the REAL document
 * end (never into the first </body> that appears inside JS print templates).
 */
const C = 'buildbook-64';
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

/** Inject overrides before the final document </body>, not the first match. */
function injectOverridesHtml(html) {
  if (!html || html.includes('telegram-overrides.js')) return html;
  // Preferred: end of the main app script then body/html close.
  const endMarker = '</script></body></html>';
  const endAt = html.lastIndexOf(endMarker);
  if (endAt >= 0) {
    return (
      html.slice(0, endAt + '</script>'.length) +
      '\n' + OVERRIDES_TAG + '\n' +
      '</body></html>'
    );
  }
  const bodyAt = html.lastIndexOf('</body>');
  if (bodyAt >= 0) {
    return html.slice(0, bodyAt) + OVERRIDES_TAG + '\n' + html.slice(bodyAt);
  }
  return html + '\n' + OVERRIDES_TAG + '\n';
}

async function withOverrides(response) {
  try {
    const ctype = response.headers.get('content-type') || '';
    if (!ctype.includes('text/html')) return response;
    const html = injectOverridesHtml(await response.text());
    const headers = new Headers(response.headers);
    // Body length changed — drop stale length so the browser does not truncate.
    headers.delete('content-length');
    return new Response(html, {
      status: response.status,
      statusText: response.statusText,
      headers,
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
          const finalResponse = isHtmlShell(event.request, url)
            ? await withOverrides(response)
            : response;
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
