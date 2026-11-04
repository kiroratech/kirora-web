import { afterEach, expect, it, vi } from 'vitest';
import { Kirora } from '../src/index.js';
import {
  accepted,
  fakeKirora,
  stubLocalStorage,
  tokenFor,
  userOf,
} from './fake-kirora.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

type Sent = {
  path: string;
  user: string | undefined;
  key: string | null;
  body?: unknown;
};

function recordRequests(answer: (sent: Sent, init: RequestInit) => Response | undefined) {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const request: Sent = {
      path: new URL(url).pathname.replace('/client/v1', ''),
      user: userOf(init),
      key: new Headers(init.headers).get('kirora-client-key'),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    sent.push(request);
    return Promise.resolve(answer(request, init) ?? accepted(init.body));
  });
  return sent;
}

const eventNames = (request: Pick<Sent, 'body'>) =>
  (request.body as { events: { name: string }[] }).events.map((e) => e.name);

it("never sends one user's events as the next user", async () => {
  let down = true;
  const sent = recordRequests(() =>
    down ? new Response(null, { status: 503 }) : undefined,
  );
  const kirora = new Kirora({ clientKey: 'kirora_pk_a', trackSessions: false });

  await kirora.identify(tokenFor('alice'));
  kirora.track('Invoice Paid');
  await kirora.flush();
  // Kirora is down, so Alice's event waits. Then Bob signs in without a logout.
  down = false;
  await kirora.identify(tokenFor('bob'));
  kirora.track('Plan Upgraded');
  await kirora.flush();
  await kirora.identify(tokenFor('alice'));
  await kirora.flush();

  const delivered = sent.filter((request) => request.path === '/events/batch').slice(1);
  expect(delivered.map((request) => [request.user, eventNames(request)])).toEqual([
    ['bob', ['Plan Upgraded']],
    ['alice', ['Invoice Paid']],
  ]);
});

it("never sends one user's events as the next, even when tokens name no user", async () => {
  let down = true;
  const sent = recordRequests(() =>
    down ? new Response(null, { status: 503 }) : undefined,
  );
  const authorizations: (string | null)[] = [];
  const recorded = fetch;
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    authorizations.push(new Headers(init.headers).get('authorization'));
    return recorded(url, init);
  });
  const kirora = new Kirora({ clientKey: 'kirora_pk_a', trackSessions: false });

  await kirora.identify('opaque-token-alice');
  kirora.track('Invoice Paid');
  await kirora.flush();
  // Kirora is down, so Alice's event waits. Then Bob signs in without a logout.
  down = false;
  await kirora.identify('opaque-token-bob');
  kirora.track('Plan Upgraded');
  await kirora.flush();

  const delivered = sent.map((request, index) => [
    authorizations[index],
    eventNames(request),
  ]);
  expect(delivered).toEqual([
    ['Bearer opaque-token-alice', ['Invoice Paid']],
    ['Bearer opaque-token-bob', ['Plan Upgraded']],
  ]);
});

it('sends events from before sign-in as whoever signs in', async () => {
  const sent = recordRequests(() => undefined);
  const kirora = new Kirora({ clientKey: 'kirora_pk_a', trackSessions: false });

  kirora.track('Signup Started');
  await kirora.identify(tokenFor('alice'));
  await kirora.flush();
  expect(sent.map((request) => [request.user, eventNames(request)])).toEqual([
    ['alice', ['Signup Started']],
  ]);
});

it("keeps two workspaces' events apart on one site", async () => {
  stubLocalStorage();
  const sent = recordRequests(() => undefined);
  const first = new Kirora({ clientKey: 'kirora_pk_a', trackSessions: false });
  const second = new Kirora({ clientKey: 'kirora_pk_b', trackSessions: false });

  first.track('Invoice Paid');
  await vi.waitFor(() =>
    expect(
      localStorage.getItem('kirora:events:kirora_pk_a@api.kirora.io'),
    ).not.toBeNull(),
  );
  await second.identify(tokenFor('alice'));
  await second.flush();
  expect(sent).toEqual([]);
});

it('never replays a refused call as the user who signed in since', async () => {
  let answerAlice: (response: Response) => void = () => undefined;
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const user = userOf(init);
    sent.push({ path: new URL(url).pathname, user, key: null });
    if (user === 'alice')
      return new Promise<Response>((resolve) => (answerAlice = resolve));
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const kirora = new Kirora({
    clientKey: 'kirora_pk_a',
    trackSessions: false,
    logLevel: 'none',
    fetchUserToken: () => Promise.resolve(tokenFor('bob', '-fresh')),
  });

  await kirora.identify(tokenFor('alice'));
  const aliceConsent = kirora.setPushConsent(true);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  // Bob signs in while Alice's call is out; then Kirora refuses Alice's token.
  await kirora.identify(tokenFor('bob'));
  answerAlice(new Response(null, { status: 401 }));

  await expect(aliceConsent).rejects.toMatchObject({ status: 401 });
  expect(sent.map((request) => request.user)).toEqual(['alice']);
});

it('lets the latest identify() win when tokens arrive out of order', async () => {
  const sent = recordRequests(() => undefined);
  const answers: ((token: string) => void)[] = [];
  const kirora = new Kirora({
    clientKey: 'kirora_pk_a',
    trackSessions: false,
    fetchUserToken: () => new Promise((resolve) => answers.push(resolve)),
  });

  const alice = kirora.identify();
  const bob = kirora.identify();
  answers[1]!(tokenFor('bob'));
  await bob;
  answers[0]!(tokenFor('alice'));
  await alice;
  kirora.track('Plan Upgraded');
  await kirora.flush();
  expect(sent.map((request) => request.user)).toEqual(['bob']);
});

it('tracks properties as they were when track() was called', async () => {
  const sent = recordRequests(() => undefined);
  const kirora = new Kirora({ clientKey: 'kirora_pk_a', trackSessions: false });

  const properties = { total: 10, items: [{ sku: 'A' }] };
  kirora.track('Order Completed', properties);
  properties.total = 999;
  properties.items[0]!.sku = 'B';
  await kirora.identify(tokenFor('alice'));
  await kirora.flush();
  const [event] = (sent[0]!.body as { events: { properties: unknown }[] }).events;
  expect(event!.properties).toEqual({ total: 10, items: [{ sku: 'A' }] });
});

it('stops sending once destroyed, leaving queued events for the next client', async () => {
  stubLocalStorage();
  const sent = recordRequests(() => undefined);
  const first = new Kirora({ clientKey: 'kirora_pk_a', trackSessions: false });
  first.track('Signup Started');
  await vi.waitFor(() =>
    expect(
      localStorage.getItem('kirora:events:kirora_pk_a@api.kirora.io'),
    ).not.toBeNull(),
  );
  first.destroy();
  first.track('Plan Upgraded');
  await first.identify(tokenFor('alice'));
  await first.flush();
  expect(sent).toEqual([]);

  const next = new Kirora({ clientKey: 'kirora_pk_a', trackSessions: false });
  await next.identify(tokenFor('alice'));
  await next.flush();
  expect(sent.map(eventNames)).toEqual([['Signup Started']]);
});

it('gives up on a fetchUserToken that never answers', async () => {
  vi.useFakeTimers();
  const kirora = new Kirora({
    clientKey: 'kirora_pk_a',
    fetchUserToken: () => new Promise<string>(() => undefined),
  });
  const identified = kirora.identify();
  const outcome = expect(identified).rejects.toMatchObject({ name: 'UserTokenError' });
  await vi.advanceTimersByTimeAsync(30_000);
  await outcome;
  vi.useRealTimers();
});

it('never signs out a user who signed in while the last one was logging out', async () => {
  let holding = false;
  const server = fakeKirora((request) => holding && request.path === '/events/batch');
  const kirora = new Kirora({ clientKey: 'kirora_pk_a', trackSessions: false });
  await kirora.identify(tokenFor('alice'));
  kirora.track('Invoice Paid');

  holding = true;
  const loggedOut = kirora.logout();
  await vi.waitFor(() => expect(server.held).toHaveLength(1));
  holding = false;
  await kirora.identify(tokenFor('bob'));
  kirora.track('Plan Upgraded');
  server.release();
  await loggedOut;

  // Still signed in: Bob's own calls still go, as Bob.
  await kirora.setPushConsent(true);
  await kirora.flush();
  const batches = server.requests.filter((request) => request.path === '/events/batch');
  expect(batches.map((request) => [request.user, eventNames(request)])).toEqual([
    ['alice', ['Invoice Paid']],
    ['bob', ['Plan Upgraded']],
  ]);
  expect(server.requests.at(-1)).toMatchObject({ path: '/push-consent', user: 'bob' });
});

it('keeps what the same user tracks after signing in again during their logout', async () => {
  stubLocalStorage();
  let holding = false;
  const server = fakeKirora((request) => holding && request.path === '/events/batch');
  const kirora = new Kirora({ clientKey: 'kirora_pk_a', trackSessions: false });
  await kirora.identify(tokenFor('alice'));
  kirora.track('Invoice Paid');

  // Every send from here waits, so what's queued stays queued.
  holding = true;
  const loggedOut = kirora.logout();
  await vi.waitFor(() => expect(server.held).toHaveLength(1));
  await kirora.identify(tokenFor('alice'));
  kirora.track('Plan Upgraded');
  server.held.shift()!();
  await loggedOut;

  const queued = localStorage.getItem('kirora:events:kirora_pk_a@api.kirora.io') ?? '[]';
  expect(
    (JSON.parse(queued) as { event: { name: string } }[]).map(({ event }) => event.name),
  ).toEqual(['Plan Upgraded']);
  kirora.destroy();
});

it('starts no session and queues nothing when consent is given after destroying', () => {
  stubLocalStorage();
  const kirora = new Kirora({ clientKey: 'kirora_pk_a', requireTrackingConsent: true });
  kirora.destroy();
  kirora.setTrackingConsent(true);
  kirora.trackPageView();
  expect(localStorage.getItem('kirora:session')).toBeNull();
  expect(localStorage.getItem('kirora:events:kirora_pk_a@api.kirora.io')).toBeNull();
});

it('forgets events left by an earlier sign-in whose token named no one', async () => {
  stubLocalStorage();
  let down = true;
  const sent = recordRequests(() =>
    down ? new Response(null, { status: 503 }) : undefined,
  );
  const kirora = new Kirora({
    clientKey: 'kirora_pk_a',
    trackSessions: false,
    logLevel: 'none',
  });
  await kirora.identify('opaque-token');
  kirora.track('Invoice Paid');
  await kirora.flush();
  kirora.destroy();
  // Long enough ago that no tab still signed in would have left it unsent.
  const key = 'kirora:events:kirora_pk_a@api.kirora.io';
  localStorage.setItem(
    key,
    localStorage
      .getItem(key)!
      .replace(/"occurredAt":"[^"]+"/, '"occurredAt":"2020-01-01T00:00:00.000Z"'),
  );

  // The next page: the same kind of token, but nothing can tell it's the same user.
  down = false;
  const next = new Kirora({ clientKey: 'kirora_pk_a', trackSessions: false });
  await next.identify('opaque-token');
  await next.flush();
  expect(sent.slice(1)).toEqual([]);
  expect(localStorage.getItem('kirora:events:kirora_pk_a@api.kirora.io')).toBeNull();
});

it('keeps recent events another tab signed in with a token naming no one may still send', async () => {
  stubLocalStorage();
  let down = true;
  recordRequests(() => (down ? new Response(null, { status: 503 }) : undefined));
  const otherTab = new Kirora({
    clientKey: 'kirora_pk_a',
    trackSessions: false,
    logLevel: 'none',
  });
  await otherTab.identify('opaque-token');
  otherTab.track('Invoice Paid');
  await otherTab.flush();

  down = false;
  const thisTab = new Kirora({ clientKey: 'kirora_pk_a', trackSessions: false });
  await thisTab.identify('opaque-token');
  await thisTab.flush();
  expect(localStorage.getItem('kirora:events:kirora_pk_a@api.kirora.io')).toContain(
    'Invoice Paid',
  );
  otherTab.destroy();
});
