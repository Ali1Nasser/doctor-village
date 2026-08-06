/**
 * public/sw.js — the service worker. Six lines of real logic.
 *
 * This is the ONLY JavaScript in the project that runs when the site is closed.
 * It exists for one reason: a browser will not deliver a push notification
 * unless a service worker is registered to receive it.
 *
 * ## What it deliberately does not do
 * No caching, no offline shell, no background sync, no fetch handler at all. A
 * service worker that intercepts fetch can serve a stale treasury balance
 * from cache and a resident cannot tell — which on a financial-transparency
 * site is a lie the software tells by itself. Money figures come from the
 * network or they do not come.
 */

self.addEventListener('push', event => {
  // A payload we cannot parse still deserves to reach the resident: the inbox
  // has the real message, so the notification only has to get them there.
  let data = { title: 'بوابة قرية الأطباء', body: 'فيه رسالة جديدة ليك', url: '/notifications' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (_) { /* keep the fallback */ }

  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    dir: 'rtl',
    lang: 'ar',
    tag: data.tag || 'qa-notification',
    // The badge and icon are deliberately omitted: an icon that 404s renders as
    // a broken image on some Androids, and we have no asset pipeline yet.
    data: { url: data.url },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/notifications';
  // Focus an already-open tab rather than opening a second one — a resident with
  // four copies of the site open is a resident who stops using it.
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) {
      if (c.url.includes(new URL(url, c.url).pathname) && 'focus' in c) return c.focus();
    }
    return self.clients.openWindow(url);
  })());
});
