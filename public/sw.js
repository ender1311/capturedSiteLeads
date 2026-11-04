// Retired (2026-11-04): the dashboard this service worker served moved to the Beacon Frontier
// admin. Browsers that installed the old worker fetch this file on their next update check; it
// clears the old caches and unregisters itself, so nothing keeps intercepting requests.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.registration.unregister();
    })()
  );
});
