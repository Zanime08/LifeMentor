/* LifeMentor service worker — Web Push receiver (docs/08 §5).
 *
 * The server pushes only time-critical, already budget-gated items. Everything the
 * push misses (tab closed, network glitch) is delivered by polling
 * GET /v1/notifications/pending on the next foreground.
 */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'LifeMentor';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || undefined,
      tag: data.tag || undefined,
      renotify: Boolean(data.urgent),
      data: { url: data.url || '/', urgent: Boolean(data.urgent) },
    }).catch(() => undefined),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(client.url.split('#')[0] + url);
          return;
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
