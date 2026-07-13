// Minimal service worker — satisfies PWA installability and caches static
// assets only. HTML is never cached: dashboard pages contain auth-gated lead
// data that must not survive sign-out or go stale.
const CACHE = "captured-shell-v3";
const SHELL = ["/icon-192.png", "/icon-512.png"];

const OFFLINE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title></head>
<body style="font-family:system-ui,sans-serif;background:#143133;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-size:20px">You're offline</h1><p style="color:#9db6b5">Reconnect to view the Captured Sites dashboard.</p></div>
</body></html>`;

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

  // Static assets: cache-first. Pages: network-only with a generic offline fallback.
  const isAsset = /\.(png|svg|ico|css|js|woff2?)$/.test(url.pathname) || url.pathname.startsWith("/_next/static");
  if (isAsset) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      }))
    );
  } else if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => new Response(OFFLINE_HTML, { headers: { "Content-Type": "text/html" } }))
    );
  }
});
