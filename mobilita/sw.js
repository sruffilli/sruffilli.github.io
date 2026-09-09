// Cache-first service worker. Everything the app needs is precached, so it
// runs with the phone in aeroplane mode; only the YouTube links need network.
//
// Bump CACHE when any precached file changes — the version string is the whole
// invalidation mechanism.

const CACHE = 'mobilita-ef9df49-202609091227';

const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './routines.json',
  './manifest.webmanifest',
  './vendor/htm-preact.module.js',
  './src/device.js',
  './src/core/format.js',
  './src/core/log.js',
  './src/core/player.js',
  './src/core/segments.js',
  './src/core/settings.js',
  './src/ui/Home.js',
  './src/ui/Player.js',
  './src/ui/Summary.js',
  './src/ui/History.js',
  './src/ui/Settings.js',
  './fonts/barlow-400.woff2',
  './fonts/barlow-condensed-600.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const open = clients.find((c) => 'focus' in c);
      if (open) return open.focus();
      return self.clients.openWindow('./');
    })
  );
});
