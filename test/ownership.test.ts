import { afterEach, expect, it, vi } from 'vitest';
import { Kirora, type KiroraOptions } from '../src/index.js';
import { accepted, fakeKirora, tokenFor, sentEvents, userOf } from './fake-kirora.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type SentEvent = { name: string; context: { sessionId?: string } };

function client(options: Partial<KiroraOptions> = {}) {
  return new Kirora({ clientKey: 'kirora_pk_a', logLevel: 'none', ...options });
}

it('makes events from before sign-in the first user’s, never the next one’s', async () => {
  // Ada's sends fail, as if offline; Bob's go.
  const sent: [string | undefined, string][] = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    const user = userOf(init);
    if (user === 'ada') return Promise.resolve(new Response(null, { status: 503 }));
    const batch = JSON.parse(String(init.body)) as { events: SentEvent[] };
    sent.push(
      ...batch.events.map((event): [string | undefined, string] => [user, event.name]),
    );
    return Promise.resolve(accepted(batch));
  });
  const kirora = client({ trackSessions: false });
  kirora.track('Pricing Viewed');

  await kirora.identify(tokenFor('ada'));
  await kirora.flush();
  // Bob replaces Ada without a logout.
  await kirora.identify(tokenFor('bob'));
  kirora.track('Invoice Paid');
  await kirora.flush();
  expect(sent).toEqual([['bob', 'Invoice Paid']]);
  kirora.destroy();
});

it('lets only one of two tabs signing in as different users take an event', async () => {
  const server = fakeKirora();
  const signedOut = client({ trackSessions: false });
  signedOut.track('Pricing Viewed');
  await vi.waitFor(() =>
    expect(
      localStorage.getItem('kirora:events:kirora_pk_a@api.kirora.io'),
    ).not.toBeNull(),
  );
  signedOut.destroy();

  const adaTab = client({ trackSessions: false });
  const bobTab = client({ trackSessions: false });
  await Promise.all([adaTab.identify(tokenFor('ada')), bobTab.identify(tokenFor('bob'))]);
  await Promise.all([adaTab.flush(), bobTab.flush()]);

  expect(sentEvents(server.handled).map(({ name }) => name)).toEqual(['Pricing Viewed']);
});

it('adopts nothing for a sign-in whose token never arrives', async () => {
  const server = fakeKirora();
  const kirora = client({
    trackSessions: false,
    fetchUserToken: () => Promise.reject(new Error('offline')),
  });
  kirora.track('Pricing Viewed');
  await expect(kirora.identify()).rejects.toThrow();
  await kirora.identify(tokenFor('bob'));
  await kirora.flush();
  expect(sentEvents(server.handled).map(({ user }) => user)).toEqual(['bob']);
});

it('starts a new visit when the user changes, and after logout', async () => {
  const server = fakeKirora();
  const kirora = client();
  await kirora.identify(tokenFor('ada'));
  kirora.track('Pricing Viewed');
  await kirora.flush();
  await kirora.identify(tokenFor('bob'));
  kirora.track('Plan Compared');
  await kirora.flush();
  await kirora.logout();
  await kirora.identify(tokenFor('bob'));
  kirora.track('Invoice Paid');
  await kirora.flush();

  const sent = sentEvents(server.handled);
  expect(sent.map(({ user, name }) => [user, name])).toEqual([
    ['ada', 'Session Started'],
    ['ada', 'Pricing Viewed'],
    ['bob', 'Session Started'],
    ['bob', 'Plan Compared'],
    ['bob', 'Session Started'],
    ['bob', 'Invoice Paid'],
  ]);
  expect(new Set(sent.map(({ sessionId }) => sessionId)).size).toBe(3);
});

it('continues a visit from before sign-in, and across a reload, for its owner', async () => {
  const server = fakeKirora();
  const first = client();
  first.track('Pricing Viewed');
  await first.identify(tokenFor('ada'));
  await first.flush();
  first.destroy();

  // The reload: the page loads before identify() is called again.
  const reloaded = client();
  await reloaded.identify(tokenFor('ada'));
  reloaded.track('Invoice Paid');
  await reloaded.flush();

  const sent = sentEvents(server.handled);
  expect(sent.map(({ name }) => name)).toEqual([
    'Session Started',
    'Pricing Viewed',
    'Invoice Paid',
  ]);
  expect(new Set(sent.map(({ sessionId }) => sessionId)).size).toBe(1);
});

it('keeps each workspace’s visit, device id and consent apart', () => {
  const a = client({ trackSessions: true });
  const b = client({ clientKey: 'kirora_pk_b', trackSessions: true });
  b.setTrackingConsent(false);
  a.track('Pricing Viewed');

  expect(localStorage.getItem('kirora:tracking-consent:kirora_pk_b@api.kirora.io')).toBe(
    'refused',
  );
  expect(localStorage.getItem('kirora:tracking-consent:kirora_pk_a@api.kirora.io')).toBe(
    null,
  );
  expect(localStorage.getItem('kirora:session:kirora_pk_a@api.kirora.io')).not.toBeNull();
  expect(localStorage.getItem('kirora:session:kirora_pk_b@api.kirora.io')).toBeNull();
  a.destroy();
  b.destroy();
});

it('gives back the events a sign-in adopted when Kirora refuses its token', async () => {
  const sent: [string | undefined, string][] = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    const user = userOf(init);
    if (user === 'mallory') return Promise.resolve(new Response(null, { status: 401 }));
    const batch = JSON.parse(String(init.body)) as { events: SentEvent[] };
    sent.push(
      ...batch.events.map((event): [string | undefined, string] => [user, event.name]),
    );
    return Promise.resolve(accepted(batch));
  });
  const kirora = client({ trackSessions: false });
  kirora.track('Pricing Viewed');
  await kirora.identify(tokenFor('mallory'));
  await kirora.flush();
  await vi.waitFor(() =>
    expect(localStorage.getItem('kirora:events:kirora_pk_a@api.kirora.io')).toContain(
      '"owner":null',
    ),
  );
  await kirora.identify(tokenFor('bob'));
  await kirora.flush();
  expect(sent).toEqual([['bob', 'Pricing Viewed']]);
  kirora.destroy();
});

it('keeps the user id out of the session cookie', () => {
  const cookies: string[] = [];
  vi.stubGlobal('location', new URL('https://example.com/'));
  vi.stubGlobal('document', {
    title: '',
    referrer: '',
    visibilityState: 'visible',
    querySelector: () => null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    get cookie() {
      return '';
    },
    set cookie(value: string) {
      cookies.push(value);
    },
  });
  vi.stubGlobal('addEventListener', () => undefined);
  vi.stubGlobal('removeEventListener', () => undefined);
  fakeKirora();
  const kirora = client();
  return kirora.identify(tokenFor('ada@example.com')).then(() => {
    kirora.track('Pricing Viewed');
    expect(cookies.some((cookie) => cookie.startsWith('kirora_session_'))).toBe(true);
    expect(cookies.join('\n')).not.toContain('ada');
    kirora.destroy();
  });
});

it('gives back adopted events after a 502, as a gateway never checked the token', async () => {
  const sent: [string | undefined, string][] = [];
  let gatewayDown = true;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    const user = userOf(init);
    if (user === 'mallory') {
      if (gatewayDown) {
        gatewayDown = false;
        return Promise.resolve(new Response(null, { status: 502 }));
      }
      return Promise.resolve(new Response(null, { status: 401 }));
    }
    const batch = JSON.parse(String(init.body)) as { events: SentEvent[] };
    sent.push(
      ...batch.events.map((event): [string | undefined, string] => [user, event.name]),
    );
    return Promise.resolve(accepted(batch));
  });
  const kirora = client({ trackSessions: false });
  kirora.track('Pricing Viewed');
  await kirora.identify(tokenFor('mallory'));
  await kirora.flush();
  await kirora.flush();
  await vi.waitFor(() =>
    expect(localStorage.getItem('kirora:events:kirora_pk_a@api.kirora.io')).toContain(
      '"owner":null',
    ),
  );
  await kirora.identify(tokenFor('bob'));
  await kirora.flush();
  expect(sent).toEqual([['bob', 'Pricing Viewed']]);
  kirora.destroy();
});

it('never signs out a user who signs in just after logout() is called', async () => {
  const server = fakeKirora();
  const kirora = client({ trackSessions: false });
  await kirora.identify(tokenFor('ada'));
  kirora.track('Pricing Viewed');
  const loggedOut = kirora.logout();
  const bob = kirora.identify(tokenFor('bob'));
  await Promise.all([loggedOut, bob]);

  await kirora.setPushConsent(true);
  expect(server.requests.at(-1)).toMatchObject({ path: '/push-consent', user: 'bob' });
  // Ada's event is dropped with her logout, never sent as Bob.
  kirora.track('Invoice Paid');
  await kirora.flush();
  expect(sentEvents(server.handled).map(({ user, name }) => [user, name])).toEqual([
    ['bob', 'Invoice Paid'],
  ]);
  kirora.destroy();
});

it("doesn't hold back the next user's events for a signed-out user's failed send", async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const sent: [string | undefined, string][] = [];
  let failAdasSend: (() => void) | undefined;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    const user = userOf(init);
    const batch = JSON.parse(String(init.body)) as { events: SentEvent[] };
    if (user === 'ada') {
      // Ada's send hangs, then fails with a long Retry-After once Bob is signed in.
      return new Promise<Response>((resolve) => {
        failAdasSend = () =>
          resolve(new Response(null, { status: 503, headers: { 'retry-after': '600' } }));
      });
    }
    sent.push(
      ...batch.events.map((event): [string | undefined, string] => [user, event.name]),
    );
    return Promise.resolve(accepted(batch));
  });
  const kirora = client({ trackSessions: false });
  await kirora.identify(tokenFor('ada'));
  kirora.track('Invoice Paid');
  void kirora.flush();
  // Her logout gives up waiting after 5 seconds.
  const loggedOut = kirora.logout();
  await vi.advanceTimersByTimeAsync(5_000);
  await loggedOut;

  await kirora.identify(tokenFor('bob'));
  kirora.track('Plan Upgraded');
  failAdasSend!();
  await vi.advanceTimersByTimeAsync(31_000);
  expect(sent).toEqual([['bob', 'Plan Upgraded']]);
  kirora.destroy();
});
