/* Service worker: makes the app installable and lets it open with no signal.
   App files are network-first (so updates arrive right away), falling back to the cached copy offline. */
const CACHE = 'dw-shell-v2';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/styles.css',
  'js/geo.js', 'js/astro.js', 'js/weather.js', 'js/store.js', 'js/engine.js', 'js/ai.js', 'js/demo.js', 'js/app.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/exifr/lite.umd.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return; // weather, map tiles, AI: straight to network
  e.respondWith(
    fetch(req, { cache: 'no-cache' }).then((res) => { // always revalidate with the server so updates show up right away
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
