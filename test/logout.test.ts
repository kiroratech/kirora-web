import { afterEach, expect, it, vi } from 'vitest';
import { fakeKirora, stubWebPush, tokenFor, userOf, pushClient } from './fake-kirora.js';
import { stubIndexedDB } from './fake-indexeddb.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Call = { method: string; path: string; user: string | undefined };

/**
 * The fake Kirora, but `override` may answer a call itself (or hang it, with a promise
 * that never settles). Returns every call, in order, as `METHOD path user`.
 */
function kiroraWith(
  override: (call: Call) => Promise<Response> | undefined = () => undefined,
) {
  fakeKirora();
  const fake = globalThis.fetch;
  const calls: string[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const call: Call = {
      method: init.method ?? 'GET',
      path: new URL(url).pathname.replace('/client/v1', ''),
      user: userOf(init),
    };
    calls.push(
      `${call.method} ${call.path.replace(/\/devices\/.+/, '/devices')} ${call.user}`,
    );
    return override(call) ?? fake(url, init);
  });
  return calls;
}

const deletes = (calls: string[]) => calls.filter((call) => call.startsWith('DELETE'));
const puts = (calls: string[]) => calls.filter((call) => call.startsWith('PUT /devices'));

async function subscription() {
  const registration = await navigator.serviceWorker.getRegistration();
  return registration!.pushManager.getSubscription();
}

const never = () => new Promise<Response>(() => undefined);
const unavailable = () => Promise.resolve(new Response(null, { status: 503 }));

it('returns within 5 seconds when the sign-in is still waiting for its token', async () => {
  vi.useFakeTimers();
  kiroraWith();
  const kirora = pushClient({
    fetchUserToken: () => new Promise<string>(() => undefined),
  });
  void kirora.identify().catch(() => undefined);
  let done = false;
  void kirora.logout().then(() => (done = true));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(done).toBe(true);
  kirora.destroy();
});

it('returns within 5 seconds when sending events hangs, and forgets the user', async () => {
  vi.useFakeTimers();
  const calls = kiroraWith((call) =>
    call.path === '/events/batch' ? never() : undefined,
  );
  const kirora = pushClient();
  await kirora.identify(tokenFor('ada'));
  kirora.track('Invoice Paid');
  let done = false;
  void kirora.logout().then(() => (done = true));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(done).toBe(true);
  await expect(kirora.setPushConsent(true)).rejects.toThrow('identify()');
  expect(calls.some((call) => call.startsWith('POST /events/batch ada'))).toBe(true);
  kirora.destroy();
});

it('never rejects, even when neither detaching nor unsubscribing works', async () => {
  stubWebPush();
  stubIndexedDB();
  const calls = kiroraWith((call) =>
    call.method === 'DELETE' ? unavailable() : undefined,
  );
  const kirora = pushClient();
  await kirora.identify(tokenFor('ada'));
  const registration = await navigator.serviceWorker.getRegistration();
  vi.spyOn(registration!.pushManager, 'getSubscription').mockRejectedValue(
    new Error('no'),
  );
  await expect(kirora.logout()).resolves.toBeUndefined();
  expect(deletes(calls)).toEqual(['DELETE /devices ada']);
  kirora.destroy();
});

it('cancels the subscription and retries the detachment in the background', async () => {
  stubWebPush();
  stubIndexedDB();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  let offline = true;
  const calls = kiroraWith((call) =>
    call.method === 'DELETE' && offline ? unavailable() : undefined,
  );
  const kirora = pushClient();
  await kirora.identify(tokenFor('ada'));
  await kirora.logout();
  expect(await subscription()).toBeNull();

  offline = false;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(deletes(calls)).toEqual(['DELETE /devices ada', 'DELETE /devices ada']);
  // Done: no more tries.
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(deletes(calls)).toHaveLength(2);
  kirora.destroy();
});

it("keeps retrying A's detachment past B's failed registration", async () => {
  stubWebPush();
  stubIndexedDB();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  let offline = true;
  const calls = kiroraWith((call) =>
    offline && (call.method === 'DELETE' || call.user === 'bob')
      ? unavailable()
      : undefined,
  );
  const kirora = pushClient();
  await kirora.identify(tokenFor('ada'));
  await kirora.logout();
  await kirora.identify(tokenFor('bob')).catch(() => undefined);

  offline = false;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(deletes(calls)).toEqual(['DELETE /devices ada', 'DELETE /devices ada']);
  kirora.destroy();
});

it("ends A's detachment once B's registration takes the browser over", async () => {
  stubWebPush();
  stubIndexedDB();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const calls = kiroraWith((call) =>
    call.method === 'DELETE' ? unavailable() : undefined,
  );
  const kirora = pushClient();
  await kirora.identify(tokenFor('ada'));
  await kirora.logout();
  await kirora.identify(tokenFor('bob'));
  expect(puts(calls)).toEqual(['PUT /devices ada', 'PUT /devices bob']);

  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(deletes(calls)).toEqual(['DELETE /devices ada']);
  kirora.destroy();
});

it('refreshes the token once at logout, then stops on a refusal', async () => {
  stubWebPush();
  stubIndexedDB();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const fetchUserToken = vi.fn(() => Promise.resolve(tokenFor('ada', 'fresh')));
  const calls = kiroraWith((call) =>
    call.method === 'DELETE'
      ? Promise.resolve(new Response(null, { status: 401 }))
      : undefined,
  );
  const kirora = pushClient({ fetchUserToken });
  await kirora.identify(tokenFor('ada'));
  await kirora.logout();
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(fetchUserToken).toHaveBeenCalledTimes(1);
  expect(deletes(calls)).toEqual(['DELETE /devices ada', 'DELETE /devices ada']);
  kirora.destroy();
});

it('stops retrying once destroyed', async () => {
  stubWebPush();
  stubIndexedDB();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const calls = kiroraWith((call) =>
    call.method === 'DELETE' ? unavailable() : undefined,
  );
  const kirora = pushClient();
  await kirora.identify(tokenFor('ada'));
  await kirora.logout();
  kirora.destroy();
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(deletes(calls)).toHaveLength(1);
});

it('turns push off for this browser, whoever signs in, until turned on again', async () => {
  stubWebPush();
  stubIndexedDB();
  const calls = kiroraWith();
  const kirora = pushClient();
  await kirora.identify(tokenFor('ada'));
  expect(await kirora.getPushStatus()).toBe('enabled');

  await kirora.setPushEnabled(false);
  expect(deletes(calls)).toEqual(['DELETE /devices ada']);
  expect(await subscription()).toBeNull();
  expect(await kirora.getPushStatus()).toBe('disabled');

  // Kept past sign-out, for the next user.
  await kirora.logout();
  await kirora.identify(tokenFor('bob'));
  expect(puts(calls)).toEqual(['PUT /devices ada']);
  expect(await kirora.getPushStatus()).toBe('disabled');

  await kirora.setPushEnabled(true);
  expect(puts(calls)).toEqual(['PUT /devices ada', 'PUT /devices bob']);
  expect(await kirora.getPushStatus()).toBe('enabled');
  kirora.destroy();
});

it('turns push back on when the prompt is answered granted', async () => {
  stubWebPush();
  stubIndexedDB();
  vi.stubGlobal('Notification', {
    permission: 'granted',
    requestPermission: () => Promise.resolve('granted'),
  });
  kiroraWith();
  const kirora = pushClient();
  await kirora.setPushEnabled(false);
  await kirora.identify(tokenFor('ada'));
  expect(await kirora.getPushStatus()).toBe('disabled');
  expect(await kirora.requestPushPermission()).toBe('granted');
  expect(await kirora.getPushStatus()).toBe('enabled');
  kirora.destroy();
});

it.each([
  ['denied', 'denied'],
  ['default', 'unanswered'],
] as const)('answers the permission first: %s is %s', async (permission, status) => {
  stubWebPush();
  vi.stubGlobal('Notification', { permission });
  kiroraWith();
  const kirora = pushClient();
  await kirora.identify(tokenFor('ada'));
  expect(await kirora.getPushStatus()).toBe(status);
  kirora.destroy();
});

it('answers unsupported without push, and disabled when signed out', async () => {
  stubWebPush();
  kiroraWith();
  const withoutPush = pushClient({ push: undefined });
  expect(await withoutPush.getPushStatus()).toBe('unsupported');
  const signedOut = pushClient();
  expect(await signedOut.getPushStatus()).toBe('disabled');
  withoutPush.destroy();
  signedOut.destroy();
});

it('answers disabled when the latest registration failed', async () => {
  stubWebPush();
  stubIndexedDB();
  let failing = false;
  kiroraWith((call) => (failing && call.method === 'PUT' ? unavailable() : undefined));
  const kirora = pushClient();
  await kirora.identify(tokenFor('ada'));
  expect(await kirora.getPushStatus()).toBe('enabled');

  failing = true;
  // Registered yesterday, so today's refresh is due, and fails.
  localStorage.setItem(
    'kirora:push-registration:kirora_pk_a@api.kirora.io',
    JSON.stringify({
      ...(JSON.parse(
        localStorage.getItem('kirora:push-registration:kirora_pk_a@api.kirora.io')!,
      ) as object),
      at: Date.now() - 25 * 60 * 60_000,
    }),
  );
  await kirora.setPushEnabled(true);
  expect(await kirora.getPushStatus()).toBe('disabled');
  kirora.destroy();
});

it('answers disabled when the browser dropped the registered subscription', async () => {
  stubWebPush();
  stubIndexedDB();
  kiroraWith();
  const kirora = pushClient();
  await kirora.identify(tokenFor('ada'));
  await (await subscription())!.unsubscribe();
  expect(await kirora.getPushStatus()).toBe('disabled');
  kirora.destroy();
});

it('refreshes an expired token to turn push off, as the user is still signed in', async () => {
  stubWebPush();
  stubIndexedDB();
  let expired = true;
  const calls = kiroraWith((call) => {
    if (call.method !== 'DELETE' || !expired) return undefined;
    expired = false;
    return Promise.resolve(new Response(null, { status: 401 }));
  });
  const fetchUserToken = vi.fn(() => Promise.resolve(tokenFor('ada', 'fresh')));
  const kirora = pushClient({ fetchUserToken });
  await kirora.identify(tokenFor('ada'));
  await kirora.setPushEnabled(false);
  expect(fetchUserToken).toHaveBeenCalledTimes(1);
  expect(deletes(calls)).toEqual(['DELETE /devices ada', 'DELETE /devices ada']);
  kirora.destroy();
});

it('forgets the subscription kept for the worker once push is turned off', async () => {
  stubWebPush();
  const databases = stubIndexedDB();
  kiroraWith();
  const kirora = pushClient();
  await kirora.identify(tokenFor('ada'));
  expect(databases.get('subscriptions')?.size).toBe(1);
  await kirora.setPushEnabled(false);
  expect(databases.get('subscriptions')?.size).toBe(0);
  kirora.destroy();
});

it('schedules nothing more when destroyed while a retry is on its way', async () => {
  stubWebPush();
  stubIndexedDB();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  let failRetry: (() => void) | undefined;
  let attempts = 0;
  const calls = kiroraWith((call) => {
    if (call.method !== 'DELETE') return undefined;
    attempts++;
    if (attempts === 1) return unavailable();
    // The retry hangs until the test lets it fail.
    return new Promise<Response>((resolve) => {
      failRetry = () => resolve(new Response(null, { status: 503 }));
    });
  });
  const kirora = pushClient();
  await kirora.identify(tokenFor('ada'));
  await kirora.logout();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(deletes(calls)).toHaveLength(2);

  kirora.destroy();
  failRetry!();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(deletes(calls)).toHaveLength(2);
});
