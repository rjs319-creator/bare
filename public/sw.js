// Service worker for Market News & Signals — enables installable PWA and
// notifications (foreground/background while the app is open or installed),
// and is ready for server-sent Web Push.
const VERSION = 'v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Clicking a notification focuses an existing tab or opens the app at #momentum.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/#momentum';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { try { await c.navigate(target); } catch {} return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

// Server-sent Web Push. Payload: {title, body, tag, kind, sev} (see lib/push-notify.js).
// tag = server alert id → duplicate deliveries of the same alert collapse into one
// notification. renotify only for confirmed triggers ('entry'): an early watch is
// explicitly not a trade, so a re-delivered one must not buzz the phone again.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  const title = d.title || 'Market Signal';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: d.tag || 'market-signal',
    renotify: d.kind !== 'early_watch',
    data: d.data || { url: '/#momentum' },
    vibrate: [100, 50, 100],
  }));
});
