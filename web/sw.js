// Squeek Out service worker: shows start alerts pushed by the watcher, even when no page is open, and opens
// the game when one is tapped. It doesn't cache anything.
self.addEventListener("push", (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch {}
  event.waitUntil(self.registration.showNotification(msg.title || "Squeek Out", {
    body: msg.body || "Squeektoshi is running!",
    tag: msg.tag || "squeekout", // the page's own alert for the same game uses the same tag, so you only see one
    renotify: true,
    requireInteraction: true,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    vibrate: [200, 100, 200, 100, 400],
    data: { url: msg.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = tabs.find((t) => new URL(t.url).origin === self.location.origin);
    if (open) { await open.focus(); return; }
    await self.clients.openWindow(url);
  })());
});
