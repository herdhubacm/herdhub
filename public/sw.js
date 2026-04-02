const CACHE_NAME = 'herdhub-v1';
const PRECACHE = [
  '/',
  '/index.html',
  '/herd-manager.html',
  '/gestation-calculator.html',
  '/market-intelligence.html',
  '/herd-vision.html',
  '/genetic-pairing.html',
  '/ranch-finance.html',
  '/digital-sales.html',
  '/logo.png',
  '/favicon.svg'
];

// Install — pre-cache key pages
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

// Activate — clear old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch — network-first for API, cache-first for assets
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls: network-first
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return resp;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        // Background refresh
        fetch(event.request).then(resp => {
          if (resp.ok) caches.open(CACHE_NAME).then(c => c.put(event.request, resp));
        }).catch(() => {});
        return cached;
      }
      return fetch(event.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return resp;
      }).catch(() => new Response('<html><body style="background:#2C1A0E;color:#F5EFE0;font-family:sans-serif;text-align:center;padding:80px 20px"><h1>You\'re Offline</h1><p>Cached data may be shown. Connect to the internet for full access.</p></body></html>', { headers: { 'Content-Type': 'text/html' } }));
    })
  );
});

// Background sync for failed writes
self.addEventListener('sync', event => {
  if (event.tag === 'sync-data') {
    event.waitUntil(Promise.resolve());
  }
});
