import { beforeAll, expect, it, vi } from 'vitest';
import { saveSubscription } from '../src/push/subscription-store.js';
import { stubIndexedDB } from './fake-indexeddb.js';
import { PUSH_APP_KEY } from './fake-kirora.js';

type Listener = (event: Record<string, unknown>) => void;
const listeners: Record<string, Listener> = {};
const shown: { title: string; options: { data?: unknown } }[] = [];
const opened: string[] = [];
const reported: { url: string; body: unknown }[] = [];
/** What happened, in order, for the tap tests. */
const timeline: string[] = [];

/** A browser tab, as the worker sees it. */
function windowClient(id: string, focused = false) {
  const messages: unknown[] = [];
  const tab = {
    id,
    focused,
    messages,
    postMessage: (message: unknown) => {
      timeline.push(`message to ${id}`);
      messages.push(message);
    },
    focus: () => {
      timeline.push(`focus ${id}`);
      return Promise.resolve(tab);
    },
  };
  return tab;
}
type Tab = ReturnType<typeof windowClient>;
/** The tabs open on the site, and the one the next openWindow() gives. */
let tabs: Tab[] = [];
let nextWindow: Tab | null = null;

beforeAll(async () => {
  vi.stubGlobal('self', {
    addEventListener: (type: string, listener: Listener) => (listeners[type] = listener),
    registration: {
      scope: 'https://example.com/',
      showNotification: (title: string, options: { data?: unknown }) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      openWindow: (url: string) => {
        opened.push(url);
        const tab = nextWindow;
        nextWindow = null;
        return Promise.resolve(tab);
      },
      matchAll: () => Promise.resolve(tabs),
    },
  });
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    reported.push({ url, body: JSON.parse(String(init.body)) });
    timeline.push(`report ${(JSON.parse(String(init.body)) as { event: string }).event}`);
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  // The page registered this browser with its own apiUrl.
  stubIndexedDB();
  await saveSubscription('https://example.com/', {
    url: 'https://api.example.com/client/v1/push-subscription-change',
    apiUrl: 'https://api.example.com',
    clientKey: 'kirora_pk_a',
    sdk: 'kirora-web/1.0.0',
    pushAppId: 'app_web',
    vapidPublicKey: PUSH_APP_KEY,
    subscription: { endpoint: 'https://push.example.com/a' },
  });
  // Through a variable: the worker is type-checked with its own WebWorker tsconfig.
  const worker = '../src/push/worker/kirora-sw.ts';
  await import(/* @vite-ignore */ worker);
});

it.each([
  'https://evil.example/t/p/abc',
  'https://api.example.com.evil.example/t/p/abc',
  'http://api.example.com/t/p/abc',
  'https://api.example.com:8443/t/p/abc',
  'https://user@api.example.com/t/p/abc',
  'https://api.example.com/t/x/abc',
  'https://api.example.com/t/p/../../steal',
  'https://api.example.com/t/p/%2e%2e/steal',
  'not a url',
])(
  'reports nowhere but under the apiUrl the page registered with: %s',
  async (trackingUrl) => {
    const before = reported.length;
    await deliver(JSON.stringify({ kirora: 'true', title: 'Hi', trackingUrl }));
    expect(reported.length).toBe(before);
  },
);

/** Delivers a push, then clicks whatever it showed. */
async function deliver(data: string, action = '') {
  const before = shown.length;
  const waits: Promise<unknown>[] = [];
  const waitUntil = (promise: Promise<unknown>) => void waits.push(promise);
  listeners.push!({ data: { json: () => JSON.parse(data) as unknown }, waitUntil });
  await Promise.all(waits);
  const notification = shown[before];
  if (!notification) return undefined;
  listeners.notificationclick!({
    action,
    notification: { data: notification.options.data, close: () => undefined },
    waitUntil,
  });
  await Promise.all(waits);
  return notification;
}

it('shows a campaign push and reports the click', async () => {
  const push = JSON.stringify({
    kirora: 'true',
    title: 'Your invoice is ready',
    actionUrl: 'https://example.com/invoices/1',
    trackingUrl: 'https://api.example.com/t/p/abc',
  });
  expect((await deliver(push))?.title).toBe('Your invoice is ready');
  expect(opened.at(-1)).toBe('https://example.com/invoices/1');
  expect(reported.at(-1)).toEqual({
    url: 'https://api.example.com/t/p/abc',
    body: { event: 'clicked' },
  });
});

it('shows a test push, which has no tracking URL, without reporting it', async () => {
  const reports = reported.length;
  const push = JSON.stringify({ kirora: 'true', title: 'Test notification' });
  expect((await deliver(push))?.title).toBe('Test notification');
  expect(reported).toHaveLength(reports);
});

it("leaves pushes without Kirora's marker alone, tracking URL or not", async () => {
  for (const marker of [{}, { kirora: 1 }]) {
    const push = {
      ...marker,
      title: 'No marker',
      trackingUrl: 'https://api.example.com/t/p/x',
    };
    expect(await deliver(JSON.stringify(push))).toBeUndefined();
  }
});

it("leaves other services' pushes and unreadable payloads alone", async () => {
  expect(
    await deliver(JSON.stringify({ notification: { title: 'FCM' } })),
  ).toBeUndefined();
  expect(await deliver('not json')).toBeUndefined();
});

/** Delivers a push without clicking it, and what it reported meanwhile. */
async function show(push: Record<string, unknown>) {
  const before = reported.length;
  const waits: Promise<unknown>[] = [];
  listeners.push!({
    data: { json: () => push },
    waitUntil: (promise: Promise<unknown>) => void waits.push(promise),
  });
  await Promise.allSettled(waits);
  return reported.slice(before);
}

it('reports a push as delivered once it is on screen', async () => {
  const shownBefore = shown.length;
  const reports = await show({
    kirora: 'true',
    title: 'Your order shipped',
    trackingUrl: 'https://api.example.com/t/p/ghi',
  });
  expect(shown).toHaveLength(shownBefore + 1);
  expect(reports).toEqual([
    { url: 'https://api.example.com/t/p/ghi', body: { event: 'delivered' } },
  ]);
});

it('reports no delivery for a push that could not be shown', async () => {
  const { registration } = self as unknown as {
    registration: { showNotification: (...args: unknown[]) => Promise<void> };
  };
  const showNotification = registration.showNotification;
  registration.showNotification = () => Promise.reject(new TypeError('No permission'));
  try {
    expect(
      await show({
        kirora: 'true',
        title: 'Hi',
        trackingUrl: 'https://api.example.com/t/p/jkl',
      }),
    ).toEqual([]);
  } finally {
    registration.showNotification = showNotification;
  }
});

it('tries a failed report once more, then drops it', async () => {
  const recordAndAnswer = fetch;
  /** Answers every report with `status`, and counts the attempts. */
  const answering = (status: number) => {
    let attempts = 0;
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      attempts++;
      return recordAndAnswer(url, init).then(() => new Response(null, { status }));
    });
    return () => attempts;
  };
  const push = {
    kirora: 'true',
    title: 'Hi',
    trackingUrl: 'https://api.example.com/t/p/mno',
  };
  try {
    for (const status of [503, 429]) {
      const attempts = answering(status);
      await show(push);
      expect(attempts()).toBe(2);
    }
    // An expired or altered token is refused for good: no second try.
    const refused = answering(400);
    await show(push);
    expect(refused()).toBe(1);
    // Taps too: one delivery and one tap, each tried twice.
    const tapped = answering(429);
    await deliver(JSON.stringify(push));
    expect(tapped()).toBe(4);
  } finally {
    vi.stubGlobal('fetch', recordAndAnswer);
  }
});

/** Shows a push and taps it, leaving the worker's work going. */
async function tap(push: Record<string, unknown>) {
  const waits: Promise<unknown>[] = [];
  const waitUntil = (promise: Promise<unknown>) => void waits.push(promise);
  listeners.push!({ data: { json: () => push }, waitUntil });
  await Promise.all(waits);
  timeline.length = 0;
  listeners.notificationclick!({
    action: '',
    notification: { data: shown.at(-1)!.options.data, close: () => undefined },
    waitUntil,
  });
  return () => Promise.all(waits);
}

/** The page's SDK saying it listens, as `push/notification-taps.ts` does. */
function pageListens(tab: Tab) {
  listeners.message!({ data: { kirora: 'listening' }, source: tab });
}

it("hands the push's data to the page its link opened, after the report", async () => {
  const page = windowClient('page-1');
  nextWindow = page;
  const done = await tap({
    kirora: 'true',
    title: 'Your order shipped',
    actionUrl: 'https://example.com/orders/42',
    trackingUrl: 'https://api.example.com/t/p/tap1',
    data: { orderId: '42' },
  });
  await vi.waitFor(() => expect(page.messages).toHaveLength(1));
  expect(timeline).toEqual(['report clicked', 'message to page-1']);
  expect(page.messages[0]).toEqual({
    kirora: 'notificationClick',
    id: expect.any(String),
    data: { orderId: '42' },
  });
  // The page's SDK wasn't listening yet: it asks once it is, and gets the same tap.
  pageListens(page);
  await done();
  expect(page.messages).toHaveLength(2);
  expect(page.messages[1]).toEqual(page.messages[0]);
});

it('holds a tap for a page whose SDK takes a while to load', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const page = windowClient('page-slow');
    nextWindow = page;
    const done = await tap({ kirora: 'true', title: 'Hi', data: { orderId: '7' } });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(page.messages).toHaveLength(1);
    pageListens(page);
    expect(page.messages).toHaveLength(2);
    expect(page.messages[1]).toEqual(page.messages[0]);
    await done();
  } finally {
    vi.useRealTimers();
  }
});

it('brings an open tab of the site forward for a push with no link', async () => {
  const other = windowClient('tab-a');
  const focused = windowClient('tab-b', true);
  tabs = [other, focused];
  const openedBefore = opened.length;
  try {
    const done = await tap({
      kirora: 'true',
      title: 'Hello',
      trackingUrl: 'https://api.example.com/t/p/tap2',
      data: { screen: 'inbox' },
    });
    await vi.waitFor(() => expect(focused.messages).toHaveLength(1));
    // An open tab already listens, so the tap isn't held for it.
    await done();
    expect(opened).toHaveLength(openedBefore);
    expect(timeline).toContain('focus tab-b');
    expect(timeline).toContain('report opened');
    expect(other.messages).toEqual([]);
  } finally {
    tabs = [];
  }
});

it("opens the site's start page for a push with no link when no tab is open", async () => {
  const done = await tap({ kirora: 'true', title: 'Hello' });
  await done();
  expect(opened.at(-1)).toBe('https://example.com/');
});
