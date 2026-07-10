// Minimal service worker — enables "Add to Home Screen" install prompts
// and caches the app shell so it still opens with no signal.
const CACHE_NAME = 'arise-cache-v2'; // bumped: forces old (broken) SW to be replaced
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) {
        // addAll() rejects entirely if ANY asset 404s.
        // Add them individually so one missing icon can't break install.
        return Promise.all(
          ASSETS.map(function (url) {
            return cache.add(url).catch(function (err) {
              console.warn('SW: failed to cache', url, err);
            });
          })
        );
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_NAME; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      // Always have a valid fallback response ready — never resolve to undefined.
      var fallback = cached || caches.match('./index.html');

      return fetch(event.request).then(function (response) {
        // Refresh the cache in the background with the latest good response.
        if (response && response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(function () {
        // Network failed (cold start, offline, etc.) — serve cached copy
        // instead of undefined, which is what caused ERR_FAILED.
        return fallback;
      });
    })
  );
});
