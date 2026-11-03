/* Kusă console shell service worker — caches static UI for offline splash. */
const CACHE = 'kusa-shell-v8';
const SHELL = [
  '/',
  '/index.html',
  '/console.js',
  '/console.css',
  '/favicon.svg',
  '/icons/pwa-192.png',
  '/icons/pwa-512.png',
];

/** Shell assets change under `kusa serve --live`; never serve a stale cache hit first. */
const NETWORK_FIRST = new Set([
  '/',
  '/index.html',
  '/console.js',
  '/console.css',
]);

self.addEventListener('install', (event) => {
  // Precache best-effort: one missing asset must not abort SW install.
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await Promise.all(
        SHELL.map((url) => cache.add(url).catch(() => undefined)),
      );
      return self.skipWaiting();
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
    )).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Manifest is never intercepted — Chrome's installability check must see
  // the live file, not a stale Cache Storage entry.
  if (url.pathname === '/manifest.webmanifest') return;

  // Never cache API / auth / live data — network only.
  if (
    url.pathname === '/health'
    || url.pathname.startsWith('/auth/')
    || url.pathname.startsWith('/kusa/')
    || url.pathname === '/settings'
    || url.pathname === '/ready'
    || url.pathname.startsWith('/mcp')
    || url.pathname.startsWith('/sessions')
    || url.pathname.startsWith('/skills')
    || url.pathname.startsWith('/git')
    || url.pathname.startsWith('/trail')
    || url.pathname.startsWith('/files')
    || url.pathname.startsWith('/search')
    || url.pathname.startsWith('/learnings')
    || url.pathname.startsWith('/monitor-data')
    || url.pathname === '/index.json'
    || url.pathname.includes('/rpc')
  ) {
    return;
  }

  // Install icons: network-first so desktop icon updates land immediately.
  if (url.pathname.startsWith('/icons/') || NETWORK_FIRST.has(url.pathname)) {
    event.respondWith(
      fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => caches.match(request).then((cached) => {
        if (cached) return cached;
        throw new Error('offline');
      })),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        event.waitUntil(
          fetch(request).then((response) => {
            if (response && response.ok) {
              return caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
            }
            return undefined;
          }).catch(() => undefined),
        );
        return cached;
      }
      return fetch(request).then((response) => {
        if (response && response.ok && request.url.startsWith(self.location.origin)) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(async () => {
        if (request.mode === 'navigate') {
          const fallback = await caches.match('/index.html') || await caches.match('/');
          if (fallback) return fallback;
        }
        throw new Error('offline');
      });
    }),
  );
});
