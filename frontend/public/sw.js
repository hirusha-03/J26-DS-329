const CACHE_NAME = 'vanilla-monitor-cache-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/manifest.json',
  '/next.svg',
  '/vercel.svg'
];

// Self-destruct if running in development mode to prevent chunk caching issues
if (
  self.location.hostname === 'localhost' ||
  self.location.hostname === '127.0.0.1' ||
  self.location.hostname.startsWith('192.168.')
) {
  self.addEventListener('install', () => {
    self.skipWaiting();
  });
  self.addEventListener('activate', (event) => {
    event.waitUntil(
      self.registration.unregister()
        .then(() => self.clients.matchAll())
        .then((clients) => {
          clients.forEach((client) => {
            if (client.url) client.navigate(client.url);
          });
        })
    );
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Bypass service worker fetch interception entirely in development
  if (
    self.location.hostname === 'localhost' ||
    self.location.hostname === '127.0.0.1' ||
    self.location.hostname.startsWith('192.168.')
  ) {
    return;
  }

  // Only cache GET requests
  if (event.request.method !== 'GET') return;

  // Skip browser extensions and chrome:// URLs
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return response;
      }).catch(() => {
        // Fallback for document pages when offline
        if (event.request.mode === 'navigate') {
          return caches.match('/');
        }
      });
    })
  );
});
