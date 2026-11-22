// Kirora's push service worker. Serve it from your site (default `/kirora-sw.js`) or
// `importScripts()` it from your own classic worker. It only handles Kirora pushes and
// leaves everything else to your own handlers.

import { DEFAULT_API_URL } from '../../api/default-api-url.js';
import { base64UrlBytes } from '../../utils/base64url.js';
import { retryAfterMs } from '../../utils/retry-after.js';
import { wait } from '../../utils/timeout.js';
import {
  readSubscription,
  saveSubscription,
  type SavedSubscription,
} from '../subscription-store.js';

declare const self: ServiceWorkerGlobalScope;

/** As Kirora sends it. Every field may be missing from an older or newer server. */
type KiroraPush = {
  /** Marks the payload as Kirora's, tracked or not: `"true"`. */
  kirora?: string;
  title?: string;
  body?: string;
  actionUrl?: string;
  iconUrl?: string;
  imageUrl?: string;
  tag?: string;
  buttons?: { title: string; url?: string }[];
  /** Where to report deliveries, opens and clicks. Missing on test sends. */
  trackingUrl?: string;
  /** The sender's own keys, for the page to route on. */
  data?: Record<string, string>;
};

/** Kept on the notification, for the click. */
type NotificationData = {
  kirora: Pick<KiroraPush, 'actionUrl' | 'trackingUrl' | 'data'> & {
    buttons: NonNullable<KiroraPush['buttons']>;
  };
};

/** A tap, as the page's SDK hears it (`push/notification-taps.ts`). */
type TapMessage = {
  kirora: 'notificationClick';
  id: string;
  data: Record<string, string>;
};

/** A tap waits this long at most for its report before the page hears of it. */
const TAP_REPORT_WAIT_MS = 1500;
/** How long a page opened by a tap has to load the SDK and ask for it, slow or not. */
const TAP_CLAIM_WAIT_MS = 60_000;
/** Taps held at most: the latest, as the page's SDK keeps them. */
const MAX_HELD_TAPS = 10;
/** Taps held for the pages they opened, oldest first, until the page's SDK asks. */
type HeldTap = { tap: TapMessage; client: string; claimed: () => void };
const heldTaps = new Set<HeldTap>();

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
  return push.kirora === 'true' ? push : undefined;
}

self.addEventListener('push', (event) => {
  const push = kiroraPush(event);
  if (!push) return;
  // Only well-formed buttons: one without a title would stop the push from showing.
  const buttons = Array.isArray(push.buttons)
    ? push.buttons.filter((button) => typeof button?.title === 'string')
    : [];
  const data: NotificationData = {
    kirora: {
      actionUrl: push.actionUrl,
      trackingUrl: push.trackingUrl,
      buttons,
      // Only its string values reach the page, which checks them.
      data: push.data,
    },
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
  const reported = data.trackingUrl
    ? report(data.trackingUrl, url ? 'clicked' : 'opened')
    : Promise.resolve();
  const tap: TapMessage = {
    kirora: 'notificationClick',
    id: `${Date.now()}-${Math.random()}`,
    data: data.data ?? {},
  };
  // The window opens at once, while the browser still allows it (Firefox: one second);
  // the page hears of the tap after its report.
  event.waitUntil(
    Promise.all([
      reported,
      showSite(url)
        .then(([client, opened]) =>
          client ? tellPage(client, tap, reported, opened) : undefined,
        )
        .catch(() => undefined),
    ]),
  );
});

/**
 * Opens the tapped link, or with none, brings the site forward: an open tab of it, or its
 * start page. The window, if it's on this site, so the page can be told of the tap, and
 * whether it was just opened.
 */
async function showSite(
  url: string | undefined,
): Promise<[WindowClient | null, boolean]> {
  const tabs = url
    ? []
    : await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const tab = tabs.find((client) => client.focused) ?? tabs[0];
  if (tab) return [await tab.focus().catch(() => tab), false];
  return [await self.clients.openWindow(url ?? self.registration.scope), true];
}

/**
 * Hands the tap to the page's SDK, after its report or 1.5 seconds. A page the tap just
 * opened may not listen yet, so the tap is also held until its SDK asks for it, for a
 * minute at most; an open tab's SDK already listens. It ignores a tap it has heard.
 */
async function tellPage(
  client: WindowClient,
  tap: TapMessage,
  reported: Promise<void>,
  opened: boolean,
): Promise<void> {
  // Not settledBy() from utils: it would bring its timeout error into the worker.
  await Promise.race([reported, wait(TAP_REPORT_WAIT_MS)]);
  client.postMessage(tap);
  if (!opened) return;
  let held: HeldTap | undefined;
  await Promise.race([
    new Promise<void>((claimed) => {
      heldTaps.add((held = { tap, client: client.id, claimed }));
      // The oldest stops waiting, and leaves at once, so the next add doesn't count it.
      if (heldTaps.size > MAX_HELD_TAPS) {
        const oldest = heldTaps.values().next().value!;
        heldTaps.delete(oldest);
        oldest.claimed();
      }
    }),
    wait(TAP_CLAIM_WAIT_MS),
  ]);
  heldTaps.delete(held!);
}

// The page's SDK asks for a tap held for it, once it listens.
self.addEventListener('message', (event) => {
  const source = event.source;
  if ((event.data as { kirora?: unknown } | null)?.kirora !== 'listening') return;
  if (!source || !('id' in source)) return;
  for (const held of heldTaps) {
    if (held.client !== source.id) continue;
    // Claimed, it stops waiting and leaves heldTaps before another event can come.
    source.postMessage(held.tap);
    held.claimed();
  }
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
  if (!(await isKirorasUrl(trackingUrl))) return;
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

/**
 * Whether `trackingUrl` is Kirora's: under `/t/p/` on the `apiUrl` the page registered
 * this browser with (or Kirora's own, if it can't be read), with no `.` or `..` segment
 * to climb out, nor a tab or newline, which URL parsing drops (so `.\t.` is `..`).
 * Nothing is posted anywhere else.
 */
async function isKirorasUrl(trackingUrl: string): Promise<boolean> {
  const saved = await readSubscription(self.registration.scope).catch(() => undefined);
  const prefix = `${saved?.apiUrl ?? DEFAULT_API_URL}/t/p/`;
  // Kirora's own never has a dot segment, in its path or query.
  return (
    trackingUrl.startsWith(prefix) &&
    !/[\t\n\r]|(^|[/\\])(\.|%2e){1,2}([/\\?#]|$)/i.test(trackingUrl.slice(prefix.length))
  );
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
  const saved = await readSubscription(scope);
  // Another service's subscription changed, or this browser never registered with Kirora
  // (or no longer is: a 404 or 409 below kept only the API address).
  if (
    !saved?.subscription.endpoint ||
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
      return void (await saveSubscription(scope, moved));
    }
    // 404: no device has the old subscription. 409: another device has the new one.
    // The API address stays, as tracking URLs are checked against it.
    if (status === 404 || status === 409) {
      return void (await saveSubscription(scope, { ...saved, subscription: {} }));
    }
    const retry = status === 0 || status === 429 || status >= 500;
    if (!retry || attempt === MOVE_ATTEMPTS) return;
    // Never sooner than Retry-After (seconds or a date), nor than the backoff. A longer
    // wait than the worker can be kept for ends it, rather than retrying early.
    const delay = Math.max(
      retryAfterMs(response?.headers.get('retry-after') ?? null) ?? 0,
      1000 * 2 ** attempt,
    );
    if (delay > MAX_RETRY_WAIT_MS) return;
    await wait(delay);
  }
}
