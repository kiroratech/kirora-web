// Kirora's push service worker. Serve it from your site (default `/kirora-sw.js`) or
// `importScripts()` it from your own classic worker. It only handles Kirora pushes and
// leaves everything else to your own handlers.

declare const self: ServiceWorkerGlobalScope;

/** As Kirora sends it. Every field may be missing from an older or newer server. */
type KiroraPush = {
  /** Marks the payload as Kirora's, tracked or not. */
  kirora?: number;
  title?: string;
  body?: string;
  actionUrl?: string;
  iconUrl?: string;
  imageUrl?: string;
  tag?: string;
  buttons?: { title: string; url?: string }[];
  /** Where to report opens and clicks. Missing on test sends. */
  trackingUrl?: string;
};

/** Kept on the notification, for the click. */
type NotificationData = {
  kirora: Pick<KiroraPush, 'actionUrl' | 'trackingUrl'> & {
    buttons: NonNullable<KiroraPush['buttons']>;
  };
};

/** Kirora's push, or undefined for anyone else's. */
function kiroraPush(event: PushEvent): KiroraPush | undefined {
  let payload: unknown;
  try {
    payload = event.data?.json();
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) return undefined;
  const push = payload as KiroraPush;
  // Servers before the `kirora` marker only sent tracked pushes.
  const ours = push.kirora !== undefined || typeof push.trackingUrl === 'string';
  return ours ? push : undefined;
}

self.addEventListener('push', (event) => {
  const push = kiroraPush(event);
  if (!push) return;
  const buttons = Array.isArray(push.buttons) ? push.buttons : [];
  const data: NotificationData = {
    kirora: { actionUrl: push.actionUrl, trackingUrl: push.trackingUrl, buttons },
  };
  event.waitUntil(
    self.registration.showNotification(push.title ?? '', {
      body: push.body,
      icon: push.iconUrl,
      tag: push.tag,
      data,
      // Not in TypeScript's NotificationOptions yet, but Chrome and Edge show them.
      ...({
        image: push.imageUrl,
        actions: buttons.map((button, index) => ({
          action: String(index),
          title: button.title,
        })),
      } as NotificationOptions),
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  const data = (event.notification.data as Partial<NotificationData> | null)?.kirora;
  if (!data) return;
  event.notification.close();
  // Buttons open their own URL, the body opens actionUrl. Opening a URL counts as a
  // click, otherwise it's an open.
  const url = event.action ? data.buttons[Number(event.action)]?.url : data.actionUrl;
  event.waitUntil(
    Promise.all([
      data.trackingUrl
        ? fetch(data.trackingUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ event: url ? 'clicked' : 'opened' }),
          }).catch(() => undefined)
        : undefined,
      url ? self.clients.openWindow(url) : undefined,
    ]),
  );
});
