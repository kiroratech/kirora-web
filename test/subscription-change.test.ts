import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  forgetSubscription,
  readSubscription,
  saveSubscription,
  type SavedSubscription,
} from '../src/push/subscription-store.js';
import { stubIndexedDB } from './fake-indexeddb.js';

const SCOPE = 'https://example.com/';
const URL = 'https://api.example.com/client/v1/push-subscription-change';

type Listener = (event: Record<string, unknown>) => void;
const listeners: Record<string, Listener> = {};

/** A subscription as the browser gives it. */
function subscription(endpoint: string) {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: `auth-${endpoint}` } }),
  };
}

/** The browser's subscription now, and how `subscribe()` was called. */
let current: ReturnType<typeof subscription> | null;
let subscribedWith: unknown;
/** Answers to the calls to Kirora, in order; the last repeats. */
let answers: (() => Promise<Response>)[];
let sent: { url: string; headers: Record<string, string>; body: unknown }[];

const saved: SavedSubscription = {
  url: URL,
  clientKey: 'kirora_pk_a',
  sdk: 'kirora-web/1.0.0',
  pushAppId: 'app_web',
  vapidPublicKey: 'AQID',
  subscription: subscription('https://push.example.com/old').toJSON(),
};

beforeAll(async () => {
  vi.stubGlobal('self', {
    addEventListener: (type: string, listener: Listener) => (listeners[type] = listener),
    registration: {
      scope: SCOPE,
      pushManager: {
        getSubscription: () => Promise.resolve(current),
        subscribe: (options: unknown) => {
          subscribedWith = options;
          current = subscription('https://push.example.com/resubscribed');
          return Promise.resolve(current);
        },
      },
    },
  });
  const worker = '../src/push/worker/kirora-sw.ts';
  await import(/* @vite-ignore */ worker);
});

beforeEach(async () => {
  stubIndexedDB();
  await saveSubscription(SCOPE, saved);
  current = null;
  subscribedWith = undefined;
  sent = [];
  answers = [() => Promise.resolve(new Response(null, { status: 204 }))];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return (answers.length > 1 ? answers.shift()! : answers[0]!)();
  });
});

/** Fires `pushsubscriptionchange` and waits for the worker to finish with it. */
async function change(
  event: { oldSubscription?: unknown; newSubscription?: unknown } = {},
) {
  const waits: Promise<unknown>[] = [];
  listeners.pushsubscriptionchange!({
    oldSubscription: null,
    newSubscription: null,
    ...event,
    waitUntil: (promise: Promise<unknown>) => void waits.push(promise),
  });
  await Promise.all(waits);
}

it('tells Kirora of the new subscription with the client key, and keeps it', async () => {
  const replacement = subscription('https://push.example.com/new');
  await change({
    oldSubscription: subscription(saved.subscription.endpoint!),
    newSubscription: replacement,
  });

  expect(sent).toEqual([
    {
      url: URL,
      headers: {
        'content-type': 'application/json',
        'kirora-client-key': 'kirora_pk_a',
        'kirora-sdk': 'kirora-web/1.0.0',
      },
      body: {
        pushAppId: 'app_web',
        oldSubscription: saved.subscription,
        newSubscription: replacement.toJSON(),
      },
    },
  ]);
  expect(sent[0]!.headers).not.toHaveProperty('authorization');
  expect((await readSubscription(SCOPE))?.subscription).toEqual(replacement.toJSON());
});

it('subscribes again with the same key when the browser gives no new subscription', async () => {
  await change();
  expect(subscribedWith).toEqual({
    userVisibleOnly: true,
    applicationServerKey: new Uint8Array([1, 2, 3]),
  });
  expect(sent[0]?.body).toMatchObject({
    oldSubscription: saved.subscription,
    newSubscription: { endpoint: 'https://push.example.com/resubscribed' },
  });
});

it('uses a subscription the page already made instead of subscribing', async () => {
  current = subscription('https://push.example.com/by-page');
  await change();
  expect(subscribedWith).toBeUndefined();
  expect(sent[0]?.body).toMatchObject({
    newSubscription: { endpoint: 'https://push.example.com/by-page' },
  });
});

it("leaves another service's subscription change, and a browser never registered, alone", async () => {
  await change({
    oldSubscription: subscription('https://push.example.com/theirs'),
    newSubscription: subscription('https://push.example.com/theirs-new'),
  });
  await forgetSubscription(SCOPE);
  await change({ newSubscription: subscription('https://push.example.com/new') });
  expect(sent).toEqual([]);
});

it('does nothing once permission is gone and it cannot subscribe again', async () => {
  const { pushManager } = (
    self as unknown as { registration: { pushManager: { subscribe: unknown } } }
  ).registration;
  const subscribe = pushManager.subscribe;
  pushManager.subscribe = () =>
    Promise.reject(new DOMException('Denied', 'NotAllowedError'));
  try {
    await change();
  } finally {
    pushManager.subscribe = subscribe;
  }
  expect(sent).toEqual([]);
});

it.each([404, 409])(
  'forgets the subscription when Kirora answers %i, without retrying',
  async (status) => {
    answers = [() => Promise.resolve(new Response(null, { status }))];
    await change({ newSubscription: subscription('https://push.example.com/new') });
    expect(sent).toHaveLength(1);
    expect(await readSubscription(SCOPE)).toBeUndefined();
  },
);

it('retries a 429 after its Retry-After, a 5xx and a network failure with backoff', async () => {
  vi.useFakeTimers();
  try {
    answers = [
      () =>
        Promise.resolve(
          new Response(null, { status: 429, headers: { 'retry-after': '5' } }),
        ),
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(new Response(null, { status: 204 })),
    ];
    const done = change({
      newSubscription: subscription('https://push.example.com/new'),
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4_000);
    await done;
    expect(sent).toHaveLength(3);
    expect((await readSubscription(SCOPE))?.subscription.endpoint).toBe(
      'https://push.example.com/new',
    );
  } finally {
    vi.useRealTimers();
  }
});

it('gives up after three attempts, or on a wait too long to keep the worker for', async () => {
  vi.useFakeTimers();
  try {
    answers = [() => Promise.resolve(new Response(null, { status: 503 }))];
    const done = change({
      newSubscription: subscription('https://push.example.com/new'),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(sent).toHaveLength(3);

    sent = [];
    answers = [
      () =>
        Promise.resolve(
          new Response(null, { status: 429, headers: { 'retry-after': '3600' } }),
        ),
    ];
    await change({ newSubscription: subscription('https://push.example.com/new') });
    expect(sent).toHaveLength(1);

    // The same as a date: two minutes away ends it too, rather than retrying early.
    sent = [];
    const inTwoMinutes = new Date(Date.now() + 120_000).toUTCString();
    answers = [
      () =>
        Promise.resolve(
          new Response(null, { status: 429, headers: { 'retry-after': inTwoMinutes } }),
        ),
    ];
    await change({ newSubscription: subscription('https://push.example.com/new') });
    expect(sent).toHaveLength(1);
    // Kept, as Kirora still has the old one.
    expect((await readSubscription(SCOPE))?.subscription).toEqual(saved.subscription);
  } finally {
    vi.useRealTimers();
  }
});

it('waits out a Retry-After date under a minute before trying again', async () => {
  vi.useFakeTimers();
  try {
    let first = true;
    answers = [
      () => {
        if (!first) return Promise.resolve(new Response(null, { status: 204 }));
        first = false;
        const inThirty = new Date(Date.now() + 30_000).toUTCString();
        return Promise.resolve(
          new Response(null, { status: 429, headers: { 'retry-after': inThirty } }),
        );
      },
    ];
    const done = change({
      newSubscription: subscription('https://push.example.com/new'),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(25_000);
    await done;
    expect(sent).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});
