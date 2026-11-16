import { afterEach, expect, it, vi } from 'vitest';
import { Kirora, type KiroraOptions } from '../src/index.js';
import {
  fakeKirora,
  PUSH_APP_KEY,
  stubLocalStorage,
  stubWebPush,
  tokenFor,
  type SentRequest,
} from './fake-kirora.js';
import { stubIndexedDB } from './fake-indexeddb.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const REGISTRATION_KEY = 'kirora:push-registration:kirora_pk_a@api.kirora.io';

function pushClient(options: Partial<KiroraOptions> = {}) {
  return new Kirora({
    clientKey: 'kirora_pk_a',
    trackSessions: false,
    push: true,
    logLevel: 'none',
    ...options,
  });
}

/** Who Kirora was told owns this browser, in order: a user for a PUT, `-user` for a DELETE. */
function deviceChanges(requests: SentRequest[]) {
  return requests
    .filter((request) => request.path.startsWith('/devices/'))
    .map((request) => (request.method === 'DELETE' ? `-${request.user}` : request.user));
}

/** Who this browser is saved as registered for, if anyone. */
function savedRegistration(): string | null | undefined {
  const saved = localStorage.getItem(REGISTRATION_KEY);
  return saved === null
    ? undefined
    : (JSON.parse(saved) as { userSubject: string }).userSubject;
}

it.each([
  ['looking up the push app', (request: SentRequest) => request.path === '/push-app'],
  ['registering the device', (request: SentRequest) => request.method === 'PUT'],
])(
  "never lets an earlier user's push registration land after a later one's, held while %s",
  async (_, step) => {
    stubLocalStorage();
    stubWebPush();
    let holding = true;
    const server = fakeKirora(
      (request) => holding && request.user === 'alice' && step(request),
    );
    const kirora = pushClient();

    const alice = kirora.identify(tokenFor('alice'));
    await vi.waitFor(() => expect(server.held).toHaveLength(1));
    const bob = kirora.identify(tokenFor('bob'));
    holding = false;
    // Long enough for Bob's registration to reach Kirora first, if it didn't wait.
    await new Promise((resolve) => setTimeout(resolve, 20));
    server.release();
    await Promise.all([alice, bob]);

    expect(deviceChanges(server.handled).at(-1)).toBe('bob');
    expect(savedRegistration()).toBe('bob');
  },
);

it("never lets an earlier user's push registration land after a later one's, held while subscribing", async () => {
  stubLocalStorage();
  let subscribed: () => void = () => undefined;
  stubWebPush(new Promise((resolve) => (subscribed = resolve)));
  const server = fakeKirora();
  const kirora = pushClient();

  const alice = kirora.identify(tokenFor('alice'));
  await vi.waitFor(() =>
    expect(server.requests.map((request) => request.path)).toContain('/push-app'),
  );
  const bob = kirora.identify(tokenFor('bob'));
  subscribed();
  await Promise.all([alice, bob]);

  expect(deviceChanges(server.handled)).toEqual(['bob']);
  expect(savedRegistration()).toBe('bob');
});

it('leaves nothing registered when logging out during a registration', async () => {
  stubLocalStorage();
  stubWebPush();
  const server = fakeKirora((request) => request.path === '/push-app');
  const kirora = pushClient();

  const alice = kirora.identify(tokenFor('alice'));
  await vi.waitFor(() => expect(server.held).toHaveLength(1));
  const loggedOut = kirora.logout();
  server.release();
  await Promise.all([alice, loggedOut]);

  expect(deviceChanges(server.handled)).toEqual(['alice', '-alice']);
  expect(savedRegistration()).toBeUndefined();
});

it("keeps the next user registered when they sign in during a logout's sending", async () => {
  // Alice's detachment still goes after Bob's registration: Kirora only detaches Alice's
  // installations, so it can't undo Bob's.
  stubLocalStorage();
  stubWebPush();
  let holding = false;
  const server = fakeKirora((request) => holding && request.path === '/events/batch');
  const kirora = pushClient();
  await kirora.identify(tokenFor('alice'));
  kirora.track('Invoice Paid');

  holding = true;
  const loggedOut = kirora.logout();
  await vi.waitFor(() => expect(server.held).toHaveLength(1));
  holding = false;
  await kirora.identify(tokenFor('bob'));
  server.release();
  await loggedOut;

  expect(deviceChanges(server.handled)).toEqual(['alice', 'bob', '-alice']);
  expect(savedRegistration()).toBe('bob');
  await kirora.setPushConsent(true);
  expect(server.requests.at(-1)).toMatchObject({ path: '/push-consent', user: 'bob' });
});

it("registers the next user after a logout's detachment, when they sign in during it", async () => {
  stubLocalStorage();
  stubWebPush();
  let holding = false;
  const server = fakeKirora((request) => holding && request.method === 'DELETE');
  const kirora = pushClient();
  await kirora.identify(tokenFor('alice'));

  holding = true;
  const loggedOut = kirora.logout();
  await vi.waitFor(() => expect(server.held).toHaveLength(1));
  holding = false;
  const bob = kirora.identify(tokenFor('bob'));
  server.release();
  await Promise.all([loggedOut, bob]);

  expect(deviceChanges(server.handled)).toEqual(['alice', '-alice', 'bob']);
  expect(savedRegistration()).toBe('bob');
  await kirora.setPushConsent(true);
  expect(server.requests.at(-1)).toMatchObject({ path: '/push-consent', user: 'bob' });
});

it("unsubscribes the browser when Kirora doesn't answer a logout's detachment in time", async () => {
  stubLocalStorage();
  stubWebPush();
  // The detachment is never answered.
  const server = fakeKirora((request) => request.method === 'DELETE');
  const kirora = pushClient();
  await kirora.identify(tokenFor('alice'));
  expect(await browserSubscription()).not.toBeNull();

  vi.useFakeTimers();
  try {
    const loggedOut = kirora.logout();
    await vi.advanceTimersByTimeAsync(5_000);
    await loggedOut;
  } finally {
    vi.useRealTimers();
  }

  expect(deviceChanges(server.requests)).toEqual(['alice', '-alice']);
  expect(await browserSubscription()).toBeNull();
  expect(savedRegistration()).toBeUndefined();
});

it('sends nothing once destroyed, even for a sign-in still waiting for its token', async () => {
  stubLocalStorage();
  stubWebPush();
  const server = fakeKirora();
  let answer: (token: string) => void = () => undefined;
  const kirora = pushClient({
    fetchUserToken: () => new Promise((resolve) => (answer = resolve)),
  });

  const identified = kirora.identify();
  kirora.destroy();
  answer(tokenFor('alice'));
  await identified;
  await kirora.setPushConsent(true);
  await kirora.logout();

  expect(server.requests).toEqual([]);
  expect(savedRegistration()).toBeUndefined();
});

it('stops a push registration under way when destroyed', async () => {
  stubLocalStorage();
  stubWebPush();
  const server = fakeKirora((request) => request.path === '/push-app');
  const kirora = pushClient();

  const identified = kirora.identify(tokenFor('alice'));
  await vi.waitFor(() => expect(server.held).toHaveLength(1));
  kirora.destroy();
  server.release();
  await identified;
  await kirora.setPushConsent(true);

  expect(server.requests.map((request) => request.path)).toEqual(['/push-app']);
  expect(savedRegistration()).toBeUndefined();
});

it('forgets the device id kept for detaching, once logout has detached the browser', async () => {
  stubLocalStorage();
  stubWebPush();
  fakeKirora();
  const kirora = pushClient({ requireTrackingConsent: true });
  kirora.setTrackingConsent(true);
  await kirora.identify(tokenFor('alice'));
  kirora.setTrackingConsent(false);
  expect(
    localStorage.getItem('kirora:installation-id:kirora_pk_a@api.kirora.io'),
  ).not.toBeNull();

  await kirora.logout();
  expect(
    localStorage.getItem('kirora:installation-id:kirora_pk_a@api.kirora.io'),
  ).toBeNull();
});

it('reuses its own subscription where the browser cannot say which key made it', async () => {
  stubLocalStorage();
  stubWebPush();
  const server = fakeKirora();
  const kirora = pushClient();
  await kirora.identify(tokenFor('alice'));
  // As in Firefox 74, which has no PushSubscription.options.
  const subscription = await browserSubscription();
  Object.defineProperty(subscription, 'options', { value: undefined });

  await kirora.logout();
  await kirora.identify(tokenFor('bob'));
  expect(deviceChanges(server.handled)).toEqual(['alice', '-alice', 'bob']);
  expect(server.requests.at(-1)?.body).toMatchObject({
    subscription: { endpoint: subscription!.endpoint },
  });
});

it('gives up on a service worker that never finishes installing', async () => {
  stubLocalStorage();
  stubWebPush();
  const stuck = {
    active: null,
    installing: { state: 'installing', addEventListener: () => undefined },
    pushManager: { getSubscription: () => Promise.resolve(null) },
  };
  vi.stubGlobal('navigator', {
    serviceWorker: {
      getRegistration: () => Promise.resolve(undefined),
      register: () => Promise.resolve(stuck),
    },
  });
  const server = fakeKirora();
  vi.useFakeTimers();
  try {
    const kirora = pushClient();
    const identified = kirora.identify(tokenFor('alice'));
    await vi.advanceTimersByTimeAsync(30_000);
    await identified;
    await kirora.logout();
    expect(deviceChanges(server.handled)).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

/** The browser's push subscription for our worker, if it has one. */
async function browserSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  return registration!.pushManager.getSubscription();
}

/** The key a subscription was made with, as bytes. */
function keyOf(subscription: PushSubscription | null): number[] {
  return [...new Uint8Array(subscription!.options.applicationServerKey!)];
}

/** A base64 key as bytes. */
function bytesOf(base64: string): number[] {
  return [...atob(base64)].map((character) => character.charCodeAt(0));
}

/** A key other than the push app's: the one a replaced push app, or another service, used. */
const OTHER_KEY = new Uint8Array([9, 9, 9]);
/** `OTHER_KEY` in base64url, as our registration record stores keys. */
const OTHER_KEY_BASE64 = 'CQkJ';

it("replaces its own subscription once it was made with a key the push app doesn't use", async () => {
  stubLocalStorage();
  stubWebPush();
  const server = fakeKirora();
  const kirora = pushClient();
  await kirora.identify(tokenFor('alice'));
  // As if the push app was replaced since: the subscription has the old app's key.
  const old = await browserSubscription();
  Object.defineProperty(old, 'options', {
    value: { applicationServerKey: OTHER_KEY.buffer },
  });

  await kirora.identify(tokenFor('bob'));

  const replaced = await browserSubscription();
  expect(replaced).not.toBe(old);
  expect(keyOf(replaced)).toEqual(bytesOf(PUSH_APP_KEY));
  expect(deviceChanges(server.handled)).toEqual(['alice', 'bob']);
});

it("leaves alone another service's subscription made with a different key", async () => {
  stubLocalStorage();
  stubWebPush();
  const server = fakeKirora();
  // Another service subscribed this worker first, with its own key.
  const registration = await navigator.serviceWorker.getRegistration();
  const theirs = await registration!.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: OTHER_KEY,
  });
  Object.defineProperty(theirs, 'endpoint', { value: 'https://push.example.com/theirs' });
  const kirora = pushClient();

  await kirora.identify(tokenFor('alice'));

  expect(await browserSubscription()).toBe(theirs);
  expect(deviceChanges(server.handled)).toEqual([]);
});

it('replaces its own subscription where the browser cannot say its key, if it recorded another', async () => {
  stubLocalStorage();
  stubWebPush();
  const server = fakeKirora();
  const kirora = pushClient();
  await kirora.identify(tokenFor('alice'));
  // As in Firefox 74, which has no PushSubscription.options.
  const old = await browserSubscription();
  Object.defineProperty(old, 'options', { value: undefined });
  // And our record says we made it with another key, before the push app was replaced.
  const record = JSON.parse(localStorage.getItem(REGISTRATION_KEY)!) as object;
  const recordWithOtherKey = { ...record, vapidPublicKey: OTHER_KEY_BASE64 };
  localStorage.setItem(REGISTRATION_KEY, JSON.stringify(recordWithOtherKey));

  await kirora.identify(tokenFor('bob'));

  expect(await browserSubscription()).not.toBe(old);
  expect(deviceChanges(server.handled)).toEqual(['alice', 'bob']);
});

it("registers with the browser's language and time zone, and nothing else about it", async () => {
  stubLocalStorage();
  stubWebPush();
  const server = fakeKirora();
  await pushClient().identify(tokenFor('alice'));

  const registration = server.requests.find((request) => request.method === 'PUT')!;
  expect(registration.body).toEqual({
    pushAppId: 'app_web',
    targetKind: 'web_push_subscription',
    permission: 'granted',
    subscription: expect.objectContaining({
      endpoint: 'https://push.example.com/subscription',
    }) as unknown,
    locale: 'en',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  // Web reports no app opens in version 1: its push opens come from taps.
  expect(server.requests.some((request) => request.path.endsWith('/app-opens'))).toBe(
    false,
  );
});

/** Blocks notifications in the stubbed browser, as a user does in site settings. */
function denyNotifications() {
  vi.stubGlobal('Notification', {
    permission: 'denied',
    requestPermission: () => Promise.resolve('denied'),
  });
}

function denials(requests: SentRequest[]) {
  return requests.filter(
    (request) =>
      request.method === 'PUT' &&
      (request.body as { permission?: string }).permission === 'denied',
  );
}

it('tells Kirora when notifications are blocked, naming the last registration', async () => {
  stubLocalStorage();
  stubWebPush();
  const server = fakeKirora();
  await pushClient().identify(tokenFor('alice'));
  denyNotifications();

  const kirora = pushClient();
  await kirora.identify(tokenFor('alice'));
  // Reported once a day, not on every start.
  await pushClient().identify(tokenFor('alice'));

  expect(denials(server.requests).map((request) => request.body)).toEqual([
    {
      pushAppId: 'app_web',
      permission: 'denied',
      lastSeenAt: '2026-11-01T00:00:01.000Z',
      locale: 'en',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  ]);
  // The denial's answer is kept: a take-over advances it.
  const saved = JSON.parse(localStorage.getItem(REGISTRATION_KEY)!) as {
    lastSeenAt: string;
  };
  expect(saved.lastSeenAt).toBe('2026-11-01T00:00:02.000Z');

  // Another user on this browser takes the device over with their denial.
  await kirora.identify(tokenFor('bob'));
  expect(denials(server.requests).map((request) => request.user)).toEqual([
    'alice',
    'bob',
  ]);
  expect(denials(server.requests)[1]!.body).toMatchObject({
    lastSeenAt: '2026-11-01T00:00:02.000Z',
  });
});

it('says nothing about a block in a browser never registered', async () => {
  stubLocalStorage();
  stubWebPush();
  denyNotifications();
  const server = fakeKirora();
  const kirora = pushClient();

  await kirora.identify(tokenFor('alice'));
  expect(await kirora.requestPushPermission()).toBe('denied');

  expect(
    server.requests.filter((request) => request.path.startsWith('/devices/')),
  ).toEqual([]);
});

it.each([404, 409])(
  'forgets the registration when Kirora answers a denial with %i',
  async (status) => {
    stubLocalStorage();
    stubWebPush();
    const server = fakeKirora(undefined, (request) =>
      denials([request]).length > 0 ? new Response(null, { status }) : undefined,
    );
    await pushClient().identify(tokenFor('alice'));
    denyNotifications();

    await pushClient().identify(tokenFor('alice'));
    await pushClient().identify(tokenFor('alice'));

    expect(denials(server.requests)).toHaveLength(1);
    expect(savedRegistration()).toBeUndefined();
  },
);

it('registers again once notifications are allowed after a block', async () => {
  stubLocalStorage();
  stubWebPush();
  const server = fakeKirora();
  await pushClient().identify(tokenFor('alice'));
  denyNotifications();
  await pushClient().identify(tokenFor('alice'));
  vi.stubGlobal('Notification', { permission: 'granted' });

  await pushClient().identify(tokenFor('alice'));

  const permissions = server.requests
    .filter((request) => request.method === 'PUT')
    .map((request) => (request.body as { permission: string }).permission);
  expect(permissions).toEqual(['granted', 'denied', 'granted']);
});

it('still answers denied when telling Kirora about it fails', async () => {
  stubLocalStorage();
  stubWebPush();
  const server = fakeKirora(undefined, (request) =>
    denials([request]).length > 0 ? new Response(null, { status: 503 }) : undefined,
  );
  const kirora = pushClient();
  await kirora.identify(tokenFor('alice'));
  denyNotifications();

  expect(await kirora.requestPushPermission()).toBe('denied');
  expect(denials(server.requests)).toHaveLength(1);
  // Kept, to try again on the next start.
  expect(savedRegistration()).toBe('alice');
});

it('keeps the registered subscription for the service worker', async () => {
  stubLocalStorage();
  stubWebPush();
  const stores = stubIndexedDB();
  fakeKirora();
  await pushClient({ apiUrl: 'https://api.example.com/' }).identify(tokenFor('alice'));

  expect(stores.get('subscriptions')?.get('https://example.com/')).toMatchObject({
    url: 'https://api.example.com/client/v1/push-subscription-change',
    clientKey: 'kirora_pk_a',
    sdk: expect.stringMatching(/^kirora-web\//) as unknown,
    vapidPublicKey: PUSH_APP_KEY,
    subscription: { endpoint: 'https://push.example.com/subscription' },
  });
});

it('registers all the same where IndexedDB is refused', async () => {
  stubLocalStorage();
  stubWebPush();
  vi.stubGlobal('indexedDB', {
    open: () => {
      throw new DOMException('Private window', 'InvalidStateError');
    },
  });
  const server = fakeKirora();
  await pushClient().identify(tokenFor('alice'));
  expect(deviceChanges(server.handled)).toEqual(['alice']);
  expect(savedRegistration()).toBe('alice');
});
