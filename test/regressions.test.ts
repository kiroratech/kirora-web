// Defects found in the 22 November 2026 pre-release audit, each pinned by the scenario
// that exposed it.
import { afterEach, expect, it, vi } from 'vitest';
import { EventQueue } from '../src/events/event-queue.js';
import { Kirora, type KiroraOptions } from '../src/index.js';
import {
  fakeKirora,
  kiroraRefusing,
  memoryStorage,
  recordSends,
  sentEvents,
  stubLocalStorage,
  tokenFor,
  userOf,
} from './fake-kirora.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const QUEUE_KEY = 'kirora:events:kirora_pk_test@api.kirora.io';
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Lets `turns` rounds of already-settled promises run, without letting any time pass. */
async function flushMicrotasks(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve();
  }
}

function client(options: Partial<KiroraOptions> = {}) {
  return new Kirora({
    clientKey: 'kirora_pk_test',
    trackSessions: false,
    logLevel: 'none',
    ...options,
  });
}

it("never sends a signed-out user's pre-sign-in events as the next user, once Kirora took their token", async () => {
  stubLocalStorage();
  let ada: 'offline' | 'expired' | 'ok' = 'ok';
  const sent = recordSends((url, init) => {
    if (url.endsWith('/push-consent')) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (userOf(init) === 'ada' && ada === 'offline') {
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    if (userOf(init) === 'ada' && ada === 'expired') {
      return Promise.resolve(new Response(null, { status: 401 }));
    }
    return undefined;
  });
  const kirora = client();
  kirora.track('Pre-login Browsing');
  ada = 'offline';
  await kirora.identify(tokenFor('ada'));
  await kirora.flush();

  // Kirora accepts Ada's token on another call: her sign-in stands.
  ada = 'ok';
  await kirora.setPushConsent(true);

  // Her token then expires, with no fetchUserToken to replace it.
  ada = 'expired';
  await kirora.flush();
  expect(localStorage.getItem(QUEUE_KEY)).toContain('Pre-login Browsing');

  // On a shared device, Ada signs out and Bob signs in.
  await kirora.logout();
  await kirora.identify(tokenFor('bob'));
  await kirora.flush();
  expect(sent).toEqual([]);
  kirora.destroy();
});

it('gives the events from before sign-in to the latest identify(), not one it replaced', async () => {
  stubLocalStorage();
  const server = fakeKirora();
  const kirora = client();
  kirora.track('Pre-login Browsing');
  await vi.waitFor(() => expect(localStorage.getItem(QUEUE_KEY)).not.toBeNull());
  await Promise.all([kirora.identify(tokenFor('ada')), kirora.identify(tokenFor('bob'))]);
  await kirora.flush();
  expect(sentEvents(server.handled).map(({ user, name }) => [user, name])).toEqual([
    ['bob', 'Pre-login Browsing'],
  ]);
  kirora.destroy();
});

it('runs without the lock where Web Locks are refused (an opaque-origin frame), never rejecting into the page', async () => {
  stubLocalStorage();
  const server = fakeKirora();
  vi.stubGlobal('navigator', {
    language: 'en',
    locks: { request: () => Promise.reject(new DOMException('opaque', 'SecurityError')) },
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  const kirora = client();
  kirora.track('Plan Upgraded');
  await kirora.identify(tokenFor('ada'));
  await expect(kirora.flush()).resolves.toBeUndefined();
  await tick(20);
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);
  expect(sentEvents(server.handled).map(({ name }) => name)).toEqual(['Plan Upgraded']);
  kirora.destroy();
});

it('gives up on an IndexedDB lock that never opens, rather than hanging identify() and logout()', async () => {
  stubLocalStorage();
  const server = fakeKirora();
  vi.stubGlobal('navigator', { language: 'en' });
  // Safari 14 can leave indexedDB.open() unanswered.
  vi.stubGlobal('indexedDB', { open: () => ({}) });
  const kirora = client();
  kirora.track('Plan Upgraded');
  await kirora.identify(tokenFor('ada'));
  await kirora.flush();
  expect(sentEvents(server.handled).map(({ name }) => name)).toEqual(['Plan Upgraded']);
  await kirora.logout();
  kirora.destroy();
}, 10_000);

it('waits out a Retry-After too long for setTimeout without firing over and over', async () => {
  stubLocalStorage();
  let requests = 0;
  vi.stubGlobal('fetch', () => {
    requests++;
    // About 35 days: past setTimeout's limit of 2^31 - 1 ms.
    return Promise.resolve(
      new Response(null, { status: 429, headers: { 'retry-after': '3000000' } }),
    );
  });
  const kirora = client();
  kirora.track('Plan Upgraded');
  await kirora.identify(tokenFor('ada'));
  await kirora.flush();
  const timers = vi.spyOn(globalThis, 'setTimeout');
  await tick(100);
  expect(requests).toBe(1);
  expect(timers.mock.calls.length).toBeLessThan(5);
  kirora.destroy();
});

it("never deletes another tab's stored events from a tab whose storage fell back to memory", async () => {
  let full = false;
  stubLocalStorage(() => full);
  fakeKirora();
  const adaTab = client();
  await adaTab.identify(tokenFor('ada'));
  // A full quota: this tab keeps its queue in memory from now on.
  full = true;
  adaTab.track('Plan Upgraded');
  await tick();
  full = false;
  const otherTab = client();
  otherTab.track('Pricing Viewed');
  await tick();
  await adaTab.flush();
  expect(localStorage.getItem(QUEUE_KEY)).toContain('Pricing Viewed');
  adaTab.destroy();
  otherTab.destroy();
});

it('keeps keepalive requests in flight together within the browser’s 64 KiB while hidden', async () => {
  stubLocalStorage();
  let inFlight = 0;
  let peak = 0;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    if (init.keepalive) {
      inFlight += new TextEncoder().encode(String(init.body)).length;
      peak = Math.max(peak, inFlight);
    }
    // Never answered: the page is going away.
    return new Promise(() => undefined);
  });
  const kirora = client();
  await kirora.identify(tokenFor('ada'));
  vi.stubGlobal('document', { visibilityState: 'hidden' });
  const note = 'x'.repeat(2_800);
  for (let index = 0; index < 19; index++) {
    kirora.track(`Note ${index}`, { note });
  }
  await tick();
  void kirora.flush();
  await tick();
  // Twenty or more waiting starts another send at once.
  for (let index = 19; index < 40; index++) {
    kirora.track(`Note ${index}`, { note });
  }
  await tick(10);
  expect(peak).toBeGreaterThan(0);
  expect(peak).toBeLessThanOrEqual(60_000);
  kirora.destroy();
});

it('keeps a session per user, so two tabs signed in as different users each keep their visit', async () => {
  stubLocalStorage();
  const server = fakeKirora();
  const adaTab = client({ trackSessions: true });
  const bobTab = client({ trackSessions: true });
  await adaTab.identify(tokenFor('ada'));
  await bobTab.identify(tokenFor('bob'));
  for (let round = 0; round < 3; round++) {
    adaTab.track('Report Exported');
    bobTab.track('Invoice Paid');
  }
  await adaTab.flush();
  await bobTab.flush();
  const started = sentEvents(server.handled).filter(
    ({ name }) => name === 'Session Started',
  );
  expect(started.map(({ user }) => user).sort()).toEqual(['ada', 'bob']);
  adaTab.destroy();
  bobTab.destroy();
});

it("leaves another user's session out of the page-load events a new user adopts on a shared device", async () => {
  stubLocalStorage();
  const server = fakeKirora();
  const adaPage = client({ trackSessions: true });
  await adaPage.identify(tokenFor('ada'));
  adaPage.track('Report Exported');
  await adaPage.flush();
  // The tab closes without logout(); Bob loads the site within the half hour.
  adaPage.destroy();
  const bobPage = client({ trackSessions: true });
  bobPage.track('Landing');
  await vi.waitFor(() => expect(localStorage.getItem(QUEUE_KEY)).not.toBeNull());
  await bobPage.identify(tokenFor('bob'));
  await bobPage.flush();
  const sent = sentEvents(server.handled);
  const adaSession = sent.find(({ name }) => name === 'Report Exported')!.sessionId;
  const landing = sent.find(({ name }) => name === 'Landing')!;
  expect(landing.user).toBe('bob');
  expect(landing.sessionId).not.toBe(adaSession);
  bobPage.destroy();
});

it('keeps a reload in the same session when the same user signs in again', async () => {
  stubLocalStorage();
  const server = fakeKirora();
  const before = client({ trackSessions: true });
  await before.identify(tokenFor('ada'));
  before.track('Report Exported');
  await before.flush();
  before.destroy();
  const reloaded = client({ trackSessions: true });
  reloaded.track('Landing');
  await vi.waitFor(() => expect(localStorage.getItem(QUEUE_KEY)).not.toBeNull());
  await reloaded.identify(tokenFor('ada'));
  await reloaded.flush();
  const sent = sentEvents(server.handled);
  const sessions = new Set(sent.map(({ sessionId }) => sessionId));
  expect(sessions.size).toBe(1);
  expect(sent.filter(({ name }) => name === 'Session Started')).toHaveLength(1);
  reloaded.destroy();
});

it("keeps an event the app tracks as the page hides, after the SDK's own hide flush", async () => {
  stubLocalStorage();
  const server = fakeKirora();
  const kirora = client();
  await kirora.identify(tokenFor('ada'));
  kirora.track('Report Exported');
  await kirora.flush();
  // During teardown a lock is granted only on a later task, too late.
  vi.stubGlobal('navigator', {
    language: 'en',
    locks: {
      request: (_name: string, operation: () => Promise<unknown>) =>
        new Promise((resolve) => setTimeout(() => resolve(operation()))),
    },
  });
  vi.stubGlobal('document', { visibilityState: 'hidden' });
  // The SDK's visibilitychange listener runs first, then the app's.
  void kirora.flush();
  kirora.track('Page Left');
  await flushMicrotasks(50);
  const sent = sentEvents(server.handled).map(({ name }) => name);
  const stored = localStorage.getItem(QUEUE_KEY) ?? '';
  expect(sent.includes('Page Left') || stored.includes('Page Left')).toBe(true);
  kirora.destroy();
});

it('never takes a refreshed token naming no one as the signed-in user’s', async () => {
  stubLocalStorage();
  const tokens = kiroraRefusing((token) => token === 'opaque-1');
  const kirora = client({ fetchUserToken: () => Promise.resolve('opaque-2') });
  kirora.track('Plan Upgraded');
  await kirora.identify('opaque-1');
  await kirora.flush();
  expect(tokens).not.toContain('opaque-2');
  kirora.destroy();
});

it('refreshes on time on a device whose clock is behind', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  stubLocalStorage();
  fakeKirora();
  const now = Math.floor(Date.now() / 1000);
  // Issued two hours "from now" by this device's clock, for one hour.
  const issuedAt = now + 2 * 3600;
  const fetchUserToken = vi.fn(() =>
    Promise.resolve(tokenFor('ada', '-fresh', { iat: issuedAt, exp: issuedAt + 3600 })),
  );
  const kirora = client({ fetchUserToken });
  await kirora.identify(tokenFor('ada', '', { iat: issuedAt, exp: issuedAt + 3600 }));
  // A minute before the hour is up by the device's own clock.
  await vi.advanceTimersByTimeAsync(3600_000 - 59_000);
  expect(fetchUserToken).toHaveBeenCalledTimes(1);
  kirora.destroy();
});

it('sends without keepalive when the browser refuses a keepalive request (Chrome 80)', async () => {
  stubLocalStorage();
  // As Chrome 80, which can't send a keepalive request needing a CORS preflight.
  const sent = recordSends((_url, init) =>
    init.keepalive ? Promise.reject(new TypeError('Failed to fetch')) : undefined,
  );
  const kirora = client();
  await kirora.identify(tokenFor('ada'));

  vi.stubGlobal('document', { visibilityState: 'hidden' });
  kirora.track('Page Left');
  await kirora.flush();
  expect(sent.map(({ name }) => name)).toEqual(['Page Left']);
  kirora.destroy();
});

it('keeps the events when a hidden send fails with and without keepalive', async () => {
  stubLocalStorage();
  const attempts: boolean[] = [];
  let online = false;
  const sent = recordSends((_url, init) => {
    attempts.push(Boolean(init.keepalive));
    return online ? undefined : Promise.reject(new TypeError('Failed to fetch'));
  });
  const kirora = client();
  await kirora.identify(tokenFor('ada'));

  vi.stubGlobal('document', { visibilityState: 'hidden' });
  kirora.track('Page Left');
  await kirora.flush();
  expect(attempts.slice(-2)).toEqual([true, false]);

  vi.stubGlobal('document', { visibilityState: 'visible' });
  online = true;
  await kirora.flush();
  expect(sent.map(({ name }) => name)).toEqual(['Page Left']);
  kirora.destroy();
});

it("waits out an accepted batch's Retry-After for the events it left unsettled", async () => {
  stubLocalStorage();
  let batches = 0;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    batches++;
    const { events } = JSON.parse(String(init.body)) as {
      events: { idempotencyKey: string }[];
    };
    return Promise.resolve(
      Response.json(
        {
          data: {
            results: events.map(({ idempotencyKey }) => ({
              idempotencyKey,
              error: { code: 'RATE_LIMITED' },
            })),
          },
        },
        { headers: { 'retry-after': '120' } },
      ),
    );
  });
  const kirora = client();
  kirora.track('Plan Upgraded');
  await kirora.identify(tokenFor('ada'));
  await kirora.flush();
  const sent = batches;
  // A flush, which skips the SDK's own backoff, doesn't cut the server's wait short.
  await kirora.flush();
  await tick(20);
  expect(batches).toBe(sent);
  kirora.destroy();
});

it("still leaves another user's session out of events a failed sign-in gave back", async () => {
  stubLocalStorage();
  // Ada's token is refused at once: her sign-in fails and gives the events back.
  const sent = recordSends((_url, init) =>
    userOf(init) === 'ada'
      ? Promise.resolve(new Response(null, { status: 401 }))
      : undefined,
  );
  // Ada was active on this browser: her session is the live one.
  const adaPage = client({ trackSessions: true });
  await adaPage.identify(tokenFor('ada'));
  adaPage.track('Report Exported');
  adaPage.destroy();
  const page = client({ trackSessions: true });
  page.track('Landing');
  await vi.waitFor(() => expect(localStorage.getItem(QUEUE_KEY)).toContain('Landing'));
  await page.identify(tokenFor('ada'));
  await page.flush();
  await page.identify(tokenFor('bob'));
  await page.flush();
  const landing = sent.find(({ name }) => name === 'Landing');
  const bobSessions = new Set(
    sent.filter(({ name }) => name !== 'Landing').map(({ sessionId }) => sessionId),
  );
  expect(landing?.user).toBe('bob');
  expect(landing?.sessionId === undefined || bobSessions.has(landing.sessionId)).toBe(
    true,
  );
  page.destroy();
});

it("keeps an event tracked while hidden after this tab's earlier clear, in order", async () => {
  const storage = memoryStorage();
  const queue = new EventQueue(storage, 'workspace');
  await queue.add(
    { idempotencyKey: 'old', name: 'Old', properties: {}, occurredAt: '', context: {} },
    null,
  );
  vi.stubGlobal('document', { visibilityState: 'hidden' });
  // Consent withdrawn, then granted again before the clear has run.
  const cleared = queue.clearAll();
  const added = queue.add(
    { idempotencyKey: 'new', name: 'New', properties: {}, occurredAt: '', context: {} },
    null,
  );
  await Promise.all([cleared, added]);
  expect(storage.getItem('kirora:events:workspace')).toContain('"new"');
  expect(storage.getItem('kirora:events:workspace')).not.toContain('"old"');
});

it('keeps a sign-in Kirora accepted, though a late answer for an earlier user arrives after', async () => {
  stubLocalStorage();
  let releaseAda = () => {};
  const adaHeld = new Promise<void>((resolve) => {
    releaseAda = resolve;
  });
  let bobBatches: 'offline' | 'expired' = 'offline';
  const sent = recordSends((url, init) => {
    const user = userOf(init);
    if (url.endsWith('/push-consent')) {
      // Ada's consent call is slow, and answers only after Bob's token was accepted.
      const answer = () => new Response(null, { status: 204 });
      return user === 'ada' ? adaHeld.then(answer) : Promise.resolve(answer());
    }
    if (user === 'bob' && bobBatches === 'offline') {
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    if (user === 'bob' && bobBatches === 'expired') {
      return Promise.resolve(new Response(null, { status: 401 }));
    }
    return undefined;
  });
  const kirora = client();

  await kirora.identify(tokenFor('ada'));
  const adaConsent = kirora.setPushConsent(true);
  await kirora.logout();

  // Bob signs in, adopting the event; Kirora accepts his token on a consent call.
  kirora.track('Pre-login Browsing');
  await kirora.identify(tokenFor('bob'));
  await kirora.flush();
  await kirora.setPushConsent(true);

  // Ada's late answer arrives, then Bob's token expires.
  releaseAda();
  await adaConsent;
  bobBatches = 'expired';
  await kirora.flush();

  // His sign-in still stands, so his events stay his, and go with his logout.
  await kirora.logout();
  await kirora.identify(tokenFor('carol'));
  await kirora.flush();
  expect(sent.filter(({ user }) => user === 'carol')).toEqual([]);
  kirora.destroy();
});

it('keeps the visit begun as the page loaded alive once the user signs in', async () => {
  const { keepSessionAlive, touchSession, endSession } =
    await import('../src/tracking/session.js');
  const storage = memoryStorage();
  const store = { storage, key: 'kirora:session:test' };
  vi.useFakeTimers({ toFake: ['Date'] });

  // The page loads before sign-in, then Ada signs in and reads for 25 minutes.
  const loaded = touchSession(store, null);
  vi.advanceTimersByTime(25 * 60_000);
  keepSessionAlive(store, 'ada');
  vi.advanceTimersByTime(25 * 60_000);
  expect(touchSession(store, 'ada')).toMatchObject({
    sessionId: loaded.sessionId,
    started: false,
  });

  // Her logout ends that visit.
  endSession(store, 'ada');
  expect(touchSession(store, null).started).toBe(true);
});
