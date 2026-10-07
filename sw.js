// Service worker (roadmap I3): keeps a copy of the app itself on the device
// so TeamSync opens with no signal. The schedule data already has its own
// offline copy (IndexedDB, src/app/local-store.ts); this covers the files
// the browser has to load before any of that code can run.
//   - Pages (navigations): network first, so a deploy shows up right away;
//     after NAV_TIMEOUT_MS on a bad signal, or offline, the saved page.
//   - The app bundle (dist/app.bundle.js?v=<version>, stamped by the
//     deploy) and assets/: saved copy first, refreshed in the background.
//     Older bundle versions are dropped once a new one is saved.
//   - Google Fonts: same, so text keeps its font offline.
//   - version.txt and everything else, including the TeamSync server, go
//     straight to the network untouched.
// Registered from src/app/offline.ts (https and localhost only).
const CACHE = 'teamsync-app-v1';
const NAV_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', 'manifest.webmanifest', 'assets/icons/icon-192.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isFont(url) {
  return url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
}

async function pageFirstFromNetwork(request) {
  const cache = await caches.open(CACHE);
  const network = fetch(request).then((res) => {
    if (res.ok) cache.put('./', res.clone());
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, NAV_TIMEOUT_MS));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch (e) { /* offline: fall through to the saved page */ }
  const saved = await cache.match('./');
  if (saved) return saved;
  return network; // nothing saved yet: wait for the network after all
}

async function savedFirst(request, url) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(request);
  const refresh = fetch(request).then(async (res) => {
    if (res.ok || res.type === 'opaque') {
      // Keep only the newest app bundle: drop the other ?v= copies.
      if (url.pathname.endsWith('/dist/app.bundle.js')) {
        const keys = await cache.keys();
        await Promise.all(keys.filter((k) => {
          const u = new URL(k.url);
          return u.pathname === url.pathname && u.search !== url.search;
        }).map((k) => cache.delete(k)));
      }
      await cache.put(request, res.clone());
    }
    return res;
  });
  if (saved) {
    refresh.catch(() => {});
    return saved;
  }
  return refresh;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Only the app page itself (not /privacy/ or /status/), since every saved
  // page lands under the one './' key.
  const scopePath = new URL(self.registration.scope).pathname;
  const isAppPage = url.origin === self.location.origin && (url.pathname === scopePath || url.pathname === scopePath + 'index.html');
  if (request.mode === 'navigate' && isAppPage) {
    event.respondWith(pageFirstFromNetwork(request));
    return;
  }
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin && (url.pathname.includes('/dist/') || url.pathname.includes('/assets/'))) {
    event.respondWith(savedFirst(request, url));
    return;
  }
  if (isFont(url)) {
    event.respondWith(savedFirst(request, url));
  }
});
