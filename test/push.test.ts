import { afterEach, expect, it, vi } from 'vitest';
import {
  fakeKirora,
  PUSH_APP_KEY,
  stubLocalStorage,
  stubWebPush,
  tokenFor,
  type SentRequest,
  pushClient,
  sentEvents,
} from './fake-kirora.js';
import { stubIndexedDB } from './fake-indexeddb.js';
import { saveSubscription } from '../src/push/subscription-store.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const REGISTRATION_KEY = 'kirora:push-registration:kirora_pk_a@api.kirora.io';
const PENDING_DETACH_KEY = 'kirora:push-pending-detach:kirora_pk_a@api.kirora.io';

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
  // Alice's detachment doesn't wait for logout's sending, so it goes before Bob's
  // registration, which is the one kept, and Bob's subscription is left alone.
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

  expect(deviceChanges(server.handled)).toEqual(['alice', '-alice', 'bob']);
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
  // The worker's record, which outlives the logout, says the subscription is ours.
  stubIndexedDB();
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
    // Nothing on record, so it's detached unconditionally, in case Kirora has it.
    expect(deviceChanges(server.handled)).toEqual(['-alice']);
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
    // Trailing slash dropped, as tracking URLs are matched under it.
    apiUrl: 'https://api.example.com',
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

it('detaches the browser at logout even while its last events never get an answer', async () => {
  stubLocalStorage();
  stubWebPush();
  const server = fakeKirora((request) => request.path === '/events/batch');
  vi.useFakeTimers();
  try {
    const kirora = pushClient();
    await kirora.identify(tokenFor('alice'));
    kirora.track('Invoice Paid');
    const loggedOut = kirora.logout();
    // The hung send doesn't hold up the detachment.
    await vi.advanceTimersByTimeAsync(100);
    expect(deviceChanges(server.handled)).toEqual(['alice', '-alice']);
    await vi.advanceTimersByTimeAsync(4_900);
    await loggedOut;
  } finally {
    vi.useRealTimers();
  }
});

it('gives events tracked during logout() to whoever signs in next', async () => {
  stubLocalStorage();
  stubWebPush();
  let holding = true;
  const server = fakeKirora((request) => holding && request.path === '/events/batch');
  const kirora = pushClient();
  await kirora.identify(tokenFor('alice'));
  kirora.track('Invoice Paid');
  const loggedOut = kirora.logout();
  await vi.waitFor(() => expect(server.held).toHaveLength(1));
  kirora.track('Pricing Viewed');
  holding = false;
  server.release();
  await loggedOut;

  await kirora.identify(tokenFor('bob'));
  await kirora.flush();
  const sentAs = sentEvents(server.handled).map(({ user, name }) => `${user}: ${name}`);
  expect(sentAs).toEqual(['alice: Invoice Paid', 'bob: Pricing Viewed']);
  kirora.destroy();
});

it("doesn't break the page in a sandboxed frame, where the service worker can't be read", () => {
  stubLocalStorage();
  stubWebPush();
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    title: '',
    referrer: '',
    cookie: '',
    querySelector: () => null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal('addEventListener', () => undefined);
  vi.stubGlobal('removeEventListener', () => undefined);
  const sandboxed = {};
  Object.defineProperty(sandboxed, 'serviceWorker', {
    enumerable: true,
    get: () => {
      throw new DOMException('Sandboxed', 'SecurityError');
    },
  });
  vi.stubGlobal('navigator', sandboxed);
  expect(() => pushClient().destroy()).not.toThrow();
});

it('leaves the subscription alone when detaching fails with no registration on record', async () => {
  stubLocalStorage();
  stubWebPush();
  const server = fakeKirora((request) => request.method === 'DELETE');
  const kirora = pushClient();
  await kirora.identify(tokenFor('alice'));
  // Its record lost, the subscription may be the site's own, not Kirora's.
  localStorage.removeItem(REGISTRATION_KEY);

  vi.useFakeTimers();
  try {
    const loggedOut = kirora.logout();
    await vi.advanceTimersByTimeAsync(5_000);
    await loggedOut;
  } finally {
    vi.useRealTimers();
  }

  // Detached all the same, but never unsubscribed.
  expect(deviceChanges(server.requests)).toEqual(['alice', '-alice']);
  expect(await browserSubscription()).not.toBeNull();
  kirora.destroy();
});

it('saves the API address for the worker as Kirora writes its own', async () => {
  stubLocalStorage();
  stubWebPush();
  const stores = stubIndexedDB();
  fakeKirora();
  await pushClient({ apiUrl: 'https://API.Example.com:443/' }).identify(
    tokenFor('alice'),
  );
  expect(stores.get('subscriptions')?.get('https://example.com/')).toMatchObject({
    apiUrl: 'https://api.example.com',
  });
});

it('turns push off without cancelling a subscription Kirora has no record of', async () => {
  stubLocalStorage();
  stubWebPush();
  fakeKirora();
  const kirora = pushClient();
  await kirora.identify(tokenFor('alice'));
  // Its record lost, the subscription may be the site's own, not Kirora's.
  localStorage.removeItem(REGISTRATION_KEY);
  await kirora.setPushEnabled(false);
  expect(await browserSubscription()).not.toBeNull();
  kirora.destroy();
});

it('says push is unsupported in a frame with no origin, as a sandboxed one has', async () => {
  stubLocalStorage();
  stubWebPush();
  vi.stubGlobal('origin', 'null');
  const kirora = pushClient();
  expect(await kirora.getPushStatus()).toBe('unsupported');
  kirora.destroy();
});

it('cancels the subscription at once when a detachment is out of time already', async () => {
  stubLocalStorage();
  stubWebPush();
  // The detachment is never answered.
  fakeKirora((request) => request.method === 'DELETE');
  const kirora = pushClient();
  await kirora.identify(tokenFor('alice'));
  const internals = kirora as unknown as {
    identity: { user: unknown };
    push: { detach(user: unknown, deadline: number): Promise<void> };
  };
  vi.useFakeTimers();
  try {
    // As logout() does when waiting for a sign-in used up its time.
    const detached = internals.push.detach(internals.identity.user, Date.now() - 1);
    await vi.advanceTimersByTimeAsync(10);
    await detached;
  } finally {
    vi.useRealTimers();
  }
  expect(await browserSubscription()).toBeNull();
  kirora.destroy();
});

// Found in the 22 November 2026 pre-release audit.

it('detaches with the lastSeenAt of a registration still under way at logout', async () => {
  stubLocalStorage();
  stubWebPush();
  let holding = false;
  const server = fakeKirora((request) => holding && request.method === 'PUT');
  const deletes: string[] = [];
  const kiroraFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    if (init.method === 'DELETE') {
      deletes.push(new URL(url).search);
    }
    return kiroraFetch(url, init);
  });
  const kirora = pushClient();
  await kirora.identify(tokenFor('alice'));
  // A day later the registration is due again, and is renewed as push is switched on.
  const record = JSON.parse(localStorage.getItem(REGISTRATION_KEY)!) as { at: number };
  record.at -= 2 * 24 * 60 * 60_000;
  localStorage.setItem(REGISTRATION_KEY, JSON.stringify(record));
  holding = true;
  const enabling = kirora.setPushEnabled(true);
  await vi.waitFor(() => expect(server.held).toHaveLength(1));
  const loggingOut = kirora.logout();
  server.release();
  await Promise.all([enabling, loggingOut]);
  // The renewal's lastSeenAt (the second registration's), or Kirora would keep it (409).
  expect(deletes).toEqual([
    `?lastSeenAt=${encodeURIComponent('2026-11-01T00:00:02.000Z')}`,
  ]);
});

it('cancels the subscription when push is switched off during its first registration', async () => {
  stubLocalStorage();
  stubWebPush();
  const server = fakeKirora((request) => request.method === 'PUT');
  const kirora = pushClient();
  const signingIn = kirora.identify(tokenFor('alice'));
  await vi.waitFor(() => expect(server.held).toHaveLength(1));
  const switchingOff = kirora.setPushEnabled(false);
  server.release();
  await Promise.all([signingIn, switchingOff]);
  expect(await browserSubscription()).toBeNull();
});

it('takes back its own subscription after a logout, once the push app changed its key', async () => {
  stubLocalStorage();
  stubIndexedDB();
  stubWebPush();
  const server = fakeKirora();
  const kirora = pushClient();
  await kirora.identify(tokenFor('alice'));
  await kirora.logout();
  // The push app was replaced since: the subscription has the old app's key.
  const old = await browserSubscription();
  Object.defineProperty(old, 'options', {
    value: { applicationServerKey: OTHER_KEY.buffer },
  });

  await kirora.identify(tokenFor('bob'));

  expect(keyOf(await browserSubscription())).toEqual(bytesOf(PUSH_APP_KEY));
  expect(deviceChanges(server.handled).at(-1)).toBe('bob');
});

it('uses the service worker the site registered itself, rather than registering a copy', async () => {
  stubLocalStorage();
  stubWebPush();
  fakeKirora();
  const register = vi.spyOn(navigator.serviceWorker, 'register');
  const kirora = pushClient();
  await kirora.identify(tokenFor('alice'));
  expect(await browserSubscription()).not.toBeNull();
  expect(register).not.toHaveBeenCalled();
});

it('takes its own subscription as made with its key where neither the browser nor a record can say', async () => {
  stubLocalStorage();
  stubIndexedDB();
  stubWebPush();
  const server = fakeKirora();
  const registration = await navigator.serviceWorker.getRegistration();
  // Ours, with both records lost (a cleared page record, a worker record not read).
  const ours = await registration!.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: OTHER_KEY,
  });
  // As in Firefox 74, which has no PushSubscription.options.
  Object.defineProperty(ours, 'options', { value: undefined });
  const kirora = pushClient();

  await kirora.identify(tokenFor('alice'));

  expect(await browserSubscription()).toBe(ours);
  expect(deviceChanges(server.handled)).toEqual(['alice']);
});

it("ignores another workspace's worker record on the same site", async () => {
  stubLocalStorage();
  stubIndexedDB();
  stubWebPush();
  const server = fakeKirora();
  const registration = await navigator.serviceWorker.getRegistration();
  // Another workspace's subscription, made with its own key, and its worker record.
  const theirs = await registration!.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: OTHER_KEY,
  });
  Object.defineProperty(theirs, 'endpoint', { value: 'https://push.example.com/theirs' });
  await saveSubscription(registration!.scope, {
    url: 'https://api.kirora.io/client/v1/push-subscription-change',
    apiUrl: 'https://api.kirora.io',
    clientKey: 'kirora_pk_other_workspace',
    sdk: 'kirora-web/0.1.0',
    pushAppId: 'app_other',
    vapidPublicKey: OTHER_KEY_BASE64,
    subscription: { endpoint: 'https://push.example.com/theirs' },
  });
  const kirora = pushClient();

  await kirora.identify(tokenFor('alice'));

  // Not taken as ours, so not replaced: the other workspace keeps its subscription.
  expect(await browserSubscription()).toBe(theirs);
  expect(deviceChanges(server.handled)).toEqual([]);
});

it("registers the browser where the worker's IndexedDB record never answers (Safari 14)", async () => {
  stubLocalStorage();
  stubWebPush();
  // indexedDB.open() left unanswered.
  vi.stubGlobal('indexedDB', { open: () => ({}) });
  const server = fakeKirora();
  const kirora = pushClient();
  await kirora.identify(tokenFor('alice'));
  expect(deviceChanges(server.handled)).toEqual(['alice']);
}, 10_000);

// The device secret (22 November 2026): detaching with no user token held.

/** The detachments Kirora was sent, as `authorization lastSeenAt-query`. */
function detaches(requests: SentRequest[]) {
  return requests
    .filter((request) => request.method === 'DELETE')
    .map((request) => `${request.authorization} ${request.search}`);
}

it('detaches with the device secret when logout() comes with nobody signed in', async () => {
  stubLocalStorage();
  stubWebPush();
  const server = fakeKirora();
  const before = pushClient();
  await before.identify(tokenFor('alice'));
  before.destroy();

  // A reload where the app restored its own session and logs out before identify().
  const reloaded = pushClient();
  await reloaded.logout();

  expect(detaches(server.handled)).toEqual([
    `Device secret-1 ?lastSeenAt=${encodeURIComponent('2026-11-01T00:00:01.000Z')}`,
  ]);
  expect(savedRegistration()).toBeUndefined();
});

it("goes on with the device secret when Kirora refuses the user's token to detach", async () => {
  stubLocalStorage();
  stubWebPush();
  const server = fakeKirora();
  const kirora = pushClient();
  await kirora.identify(tokenFor('alice'));

  server.answerFirst = (request) =>
    request.method === 'DELETE' && request.authorization?.startsWith('Bearer')
      ? Promise.resolve(new Response(null, { status: 401 }))
      : undefined;
  await kirora.logout();

  const sent = detaches(server.handled);
  expect(sent[0]).toMatch(/^Bearer /);
  expect(sent.at(-1)).toMatch(/^Device secret-1 /);
});

it('carries on with a detachment still being retried after a reload, by its secret', async () => {
  stubLocalStorage();
  stubWebPush();
  const server = fakeKirora();
  const kirora = pushClient();
  await kirora.identify(tokenFor('alice'));

  // Kirora can't be reached as Alice logs out: the detachment is left to retry.
  server.answerFirst = (request) =>
    request.method === 'DELETE'
      ? Promise.reject(new TypeError('Failed to fetch'))
      : undefined;
  await kirora.logout();
  kirora.destroy();
  expect(localStorage.getItem(PENDING_DETACH_KEY)).toContain('secret-1');

  // The next page, back online.
  server.answerFirst = undefined;
  server.handled.length = 0;
  const next = pushClient();
  await vi.waitFor(() => expect(detaches(server.handled)).toHaveLength(1));
  expect(detaches(server.handled)[0]).toMatch(/^Device secret-1 /);
  await vi.waitFor(() => expect(localStorage.getItem(PENDING_DETACH_KEY)).toBeNull());
  next.destroy();
});
