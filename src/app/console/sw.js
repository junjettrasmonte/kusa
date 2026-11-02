/* Kusă console shell service worker — caches static UI for offline splash. */
const CACHE = 'kusa-shell-v1';
const SHELL = [
  './dashboard.html',
  './dashboard.js',
  './dashboard.css',
  './favicon.svg',
  './manifest.webmanifest',
  './icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
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
    || url.pathname === '/dashboard.md'
    || url.pathname.includes('/rpc')
  ) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        // Stale-while-revalidate for shell assets when serve is up.
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
          const fallback = await caches.match('./dashboard.html');
          if (fallback) return fallback;
        }
        throw new Error('offline');
      });
    }),
  );
});
