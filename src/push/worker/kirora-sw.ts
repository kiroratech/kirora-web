// Kirora's push service worker. Serve it from your site (default `/kirora-sw.js`) or
// `importScripts()` it from your own classic worker. It only handles Kirora pushes and
// leaves everything else to your own handlers.

import { base64UrlBytes } from '../../utils/base64url.js';
import { savedSubscription, type SavedSubscription } from '../subscription-store.js';

declare const self: ServiceWorkerGlobalScope;

/** As Kirora sends it. Every field may be missing from an older or newer server. */
type KiroraPush = {
  /** Marks the payload as Kirora's, tracked or not: `"true"`, or `1` from older servers. */
  kirora?: string | number;
  title?: string;
  body?: string;
  actionUrl?: string;
  iconUrl?: string;
  imageUrl?: string;
  tag?: string;
  buttons?: { title: string; url?: string }[];
  /** Where to report deliveries, opens and clicks. Missing on test sends. */
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
  const { trackingUrl } = push;
  event.waitUntil(
    self.registration
      .showNotification(push.title ?? '', {
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
      })
      // On screen, so delivered. Test sends have no tracking URL.
      .then(() => (trackingUrl ? report(trackingUrl, 'delivered') : undefined)),
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
      data.trackingUrl ? report(data.trackingUrl, url ? 'clicked' : 'opened') : undefined,
      url ? self.clients.openWindow(url) : undefined,
    ]),
  );
});

/**
 * Reports a push delivered (on screen) or tapped to its tracking URL, which names the
 * device it went to. Never rejects. A best-effort count: a failed report is tried once
 * more, then dropped, rather than keeping the worker alive for it. A repeat changes
 * nothing on Kirora's side.
 */
async function report(
  trackingUrl: string,
  event: 'delivered' | 'opened' | 'clicked',
): Promise<void> {
  const send = () =>
    fetch(trackingUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event }),
    }).then(
      // Any other 4xx would be refused again.
      (response) => response.status < 500 && response.status !== 429,
      () => false,
    );
  if (!(await send())) await send();
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(moveSubscription(event).catch(() => undefined));
});

/** Attempts at telling Kirora, and the longest wait between two. */
const MOVE_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 60_000;

/**
 * Tells Kirora the browser replaced the subscription the page registered, so the device
 * keeps its user and stays reachable. The old subscription's `auth` key proves the device,
 * as the worker has no user token. A device signed out or denied meanwhile stays off.
 */
async function moveSubscription(event: PushSubscriptionChangeEvent): Promise<void> {
  const { scope, pushManager } = self.registration;
  const saved = await savedSubscription(scope);
  // Another service's subscription changed, or this browser never registered with Kirora.
  if (
    !saved ||
    (event.oldSubscription &&
      event.oldSubscription.endpoint !== saved.subscription.endpoint)
  ) {
    return;
  }
  // Rejects if permission was taken away: then there's nothing to move to.
  const replacement =
    event.newSubscription ??
    (await pushManager.getSubscription()) ??
    (await pushManager.subscribe({
      userVisibleOnly: true,
      // As bytes: not every supported browser takes the base64 string.
      applicationServerKey: base64UrlBytes(saved.vapidPublicKey),
    }));
  const newSubscription = replacement.toJSON();
  if (newSubscription.endpoint === saved.subscription.endpoint) return;
  const body = JSON.stringify({
    pushAppId: saved.pushAppId,
    oldSubscription: saved.subscription,
    newSubscription,
  });
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(saved.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'kirora-client-key': saved.clientKey,
        'kirora-sdk': saved.sdk,
      },
      body,
    }).catch(() => undefined);
    const status = response?.status ?? 0;
    if (status === 204) {
      const moved: SavedSubscription = { ...saved, subscription: newSubscription };
      return void (await savedSubscription(scope, moved));
    }
    // 404: no device has the old subscription. 409: another device has the new one.
    if (status === 404 || status === 409) {
      return void (await savedSubscription(scope, null));
    }
    const retry = status === 0 || status === 429 || status >= 500;
    if (!retry || attempt === MOVE_ATTEMPTS) return;
    // Retry-After in seconds, or backoff; a date isn't worth parsing here.
    const wait = Math.max(
      Number(response?.headers.get('retry-after')) * 1000 || 0,
      1000 * 2 ** attempt,
    );
    if (wait > MAX_RETRY_WAIT_MS) return;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
