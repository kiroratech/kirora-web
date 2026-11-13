import { beforeAll, expect, it, vi } from 'vitest';

type Listener = (event: Record<string, unknown>) => void;
const listeners: Record<string, Listener> = {};
const shown: { title: string; options: { data?: unknown } }[] = [];
const opened: string[] = [];
const reported: { url: string; body: unknown }[] = [];

beforeAll(async () => {
  vi.stubGlobal('self', {
    addEventListener: (type: string, listener: Listener) => (listeners[type] = listener),
    registration: {
      showNotification: (title: string, options: { data?: unknown }) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: { openWindow: (url: string) => void opened.push(url) },
  });
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    reported.push({ url, body: JSON.parse(String(init.body)) });
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  // Through a variable: the worker is type-checked with its own WebWorker tsconfig.
  const worker = '../src/push/worker/kirora-sw.ts';
  await import(/* @vite-ignore */ worker);
});

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
    kirora: 1,
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
  const push = JSON.stringify({ kirora: 1, title: 'Test notification' });
  expect((await deliver(push))?.title).toBe('Test notification');
  expect(reported).toHaveLength(reports);
});

it('still shows pushes from servers before the kirora marker', async () => {
  const push = JSON.stringify({ title: 'Old server', trackingUrl: 'https://t/p/x' });
  expect((await deliver(push))?.title).toBe('Old server');
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
    kirora: 1,
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
      await show({ kirora: 1, title: 'Hi', trackingUrl: 'https://t/p/jkl' }),
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
  const push = { kirora: 1, title: 'Hi', trackingUrl: 'https://t/p/mno' };
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
