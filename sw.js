/* Barbershop service worker — offline-first app shell.
   Strategy: stale-while-revalidate — serve from cache instantly (works fully
   offline), refresh the cache in the background when online so the next
   launch picks up app updates automatically. */
const CACHE = 'barbershop-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const refresh = fetch(e.request).then((res) => {
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      }).catch(() => null);
      if (cached) {
        e.waitUntil ? refresh : null; // background refresh; result intentionally unused
        return cached;
      }
      const fresh = await refresh;
      if (fresh) return fresh;
      if (e.request.mode === 'navigate') return cache.match('./index.html');
      return Response.error();
    })
  );
});
