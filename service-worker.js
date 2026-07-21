// Cleanup worker: immediately unregister itself and delete old caches.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Delete all runtime caches
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((cacheName) => cacheName.includes("qcm") || cacheName.includes("runtime"))
        .map((cacheName) => caches.delete(cacheName))
    );

    // Unregister this worker
    await self.registration.unregister().catch(() => {});

    // Notify all clients to reload
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    clients.forEach((client) => {
      client.postMessage({ type: "RELOAD" });
    });
  })());
});
