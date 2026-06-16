const CACHE_VERSION = 'herdhub-v3';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const API_CACHE = `${CACHE_VERSION}-api`;

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/catalog.html',
  '/herd-manager.html',
  '/gestation-calculator.html',
  '/market-intelligence.html',
  '/herd-vision.html',
  '/genetic-pairing.html',
  '/ranch-finance.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/manifest.json'
];

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Herd Hub — Offline</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0A0A0A; color: #F5EFE0;
    font-family: -apple-system, 'Inter', sans-serif;
    min-height: 100vh; display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    padding: 24px; text-align: center;
  }
  .icon { font-size: 48px; margin-bottom: 20px; }
  h1 {
    font-size: 24px; font-weight: 700; margin-bottom: 10px;
    color: #F5EFE0;
  }
  p { font-size: 15px; color: #8C7560; line-height: 1.6; max-width: 320px; }
  .rule { width: 40px; height: 2px; background: #8B3214; margin: 20px auto; }
  .url { font-size: 13px; color: #C9A96E; margin-top: 16px; }
</style>
</head>
<body>
  <div class="icon">🐄</div>
  <h1>You're Offline</h1>
  <div class="rule"></div>
  <p>Herd Hub needs a connection to load live listings and market prices. Connect to the internet and try again.</p>
  <div class="url">theherdhub.com</div>
</body>
</html>`;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('Precache failed:', err))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== STATIC_CACHE && k !== API_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and chrome-extension requests
  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // API: network first, cache fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(API_CACHE).then(c => c.put(request, clone));
          }
          return resp;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // HTML pages: network first, cache fallback, offline page last
  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(STATIC_CACHE).then(c => c.put(request, clone));
          }
          return resp;
        })
        .catch(() =>
          caches.match(request)
            .then(cached => cached || new Response(OFFLINE_HTML, {
              headers: { 'Content-Type': 'text/html' }
            }))
        )
    );
    return;
  }

  // Static assets: cache first, network fallback
  event.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request).then(resp => {
        if (resp.ok) {
          caches.open(STATIC_CACHE).then(c => c.put(request, resp.clone()));
        }
        return resp;
      }).catch(() => null);

      return cached || networkFetch;
    })
  );
});
