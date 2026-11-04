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
