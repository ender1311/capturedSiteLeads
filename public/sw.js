// Minimal service worker — satisfies PWA installability and caches the app
// shell/icons. Auth-gated data is always fetched fresh from the network.
const CACHE = "captured-shell-v1";
const SHELL = ["/dashboard", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API responses or auth flows — always hit the network.
  if (url.pathname.startsWith("/api")) return;

  // Static assets: cache-first. Everything else: network-first with cache fallback.
  const isAsset = /\.(png|svg|ico|css|js|woff2?)$/.test(url.pathname) || url.pathname.startsWith("/_next/static");
  if (isAsset) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      }))
    );
  } else {
    event.respondWith(fetch(request).catch(() => caches.match(request).then((h) => h || caches.match("/dashboard"))));
  }
});
