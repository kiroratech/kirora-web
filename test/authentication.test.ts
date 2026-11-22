import { afterEach, expect, it, vi } from 'vitest';
import { Kirora, type AuthenticationFailureReason } from '../src/index.js';
import { accepted, kiroraRefusing, stubWebPush, tokenFor } from './fake-kirora.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A token for `sub` expiring at `exp` (epoch seconds), as the app's server signs one. */
const tokenExpiring = (sub: string, exp: number, variant = '', iat?: number) =>
  tokenFor(sub, variant, { exp, iat });

function client(options: {
  fetchUserToken?: () => Promise<string>;
  onAuthenticationFailed?: (reason: AuthenticationFailureReason) => void;
  push?: true;
}) {
  return new Kirora({
    clientKey: 'kirora_pk_test',
    trackSessions: false,
    logLevel: 'none',
    ...options,
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

it('tells the app once when Kirora refuses a token it cannot replace', async () => {
  kiroraRefusing((token) => token.startsWith('expired'));
  const failures: AuthenticationFailureReason[] = [];
  const kirora = client({ onAuthenticationFailed: (reason) => failures.push(reason) });
  kirora.track('Plan Upgraded');
  await kirora.identify('expired-token-1');
  await vi.waitFor(() => expect(failures).toEqual(['refused']));
  await kirora.flush();
  await tick();
  expect(failures).toEqual(['refused']);

  // A new sign-in is news again.
  await kirora.identify('expired-token-2');
  await vi.waitFor(() => expect(failures).toEqual(['refused', 'refused']));
});

it('tells the app once when fetchUserToken fails in the background, again after a success', async () => {
  const expired = tokenFor('ada', '-expired');
  const fresh = tokenFor('ada', '-fresh');
  const tokens = kiroraRefusing((token) => token === expired);
  let failing = true;
  const failures: AuthenticationFailureReason[] = [];
  const kirora = client({
    fetchUserToken: () =>
      failing ? Promise.reject(new Error('offline')) : Promise.resolve(fresh),
    onAuthenticationFailed: (reason) => failures.push(reason),
  });
  kirora.track('Plan Upgraded');
  await kirora.identify(expired);
  await vi.waitFor(() => expect(failures).toEqual(['fetch_failed']));
  await kirora.flush();
  await tick();
  expect(failures).toEqual(['fetch_failed']);

  failing = false;
  await kirora.flush();
  expect(tokens.at(-1)).toBe(fresh);
});

it("doesn't call it for a failure a method rejects with, or during logout()", async () => {
  kiroraRefusing((token) => token.startsWith('expired'));
  const failures: AuthenticationFailureReason[] = [];
  const kirora = client({
    fetchUserToken: () => Promise.reject(new Error('offline')),
    onAuthenticationFailed: (reason) => failures.push(reason),
  });
  await expect(kirora.identify()).rejects.toMatchObject({ name: 'UserTokenError' });

  // Signed in, but logged out before anything is sent: logout's own send is refused.
  kirora.track('Plan Upgraded');
  await kirora.identify('expired-token');
  await kirora.logout();
  await tick();
  expect(failures).toEqual([]);
});

it('keeps going when onAuthenticationFailed throws', async () => {
  kiroraRefusing(() => true);
  let called = false;
  const kirora = client({
    onAuthenticationFailed: () => {
      called = true;
      throw new Error('the app broke');
    },
  });
  kirora.track('Plan Upgraded');
  await kirora.identify('expired-token');
  await vi.waitFor(() => expect(called).toBe(true));
});

it('asks for a fresh token a minute before the current one expires', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const now = Math.floor(Date.now() / 1000);
  const tokens = kiroraRefusing(() => false);
  const fetchUserToken = vi.fn(() =>
    Promise.resolve(tokenExpiring('ada', now + 3600, '-fresh')),
  );
  const kirora = client({ fetchUserToken });
  await kirora.identify(tokenExpiring('ada', now + 120));

  await vi.advanceTimersByTimeAsync(59_000);
  expect(fetchUserToken).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(fetchUserToken).toHaveBeenCalledTimes(1);

  kirora.track('Plan Upgraded');
  await kirora.flush();
  expect(tokens.at(-1)).toBe(tokenExpiring('ada', now + 3600, '-fresh'));
  // The fresh token's own refresh is an hour away.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchUserToken).toHaveBeenCalledTimes(1);
  kirora.destroy();
});

it("doesn't ask again at once when the fresh token is just as close to expiring", async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const now = Math.floor(Date.now() / 1000);
  kiroraRefusing(() => false);
  const fetchUserToken = vi.fn(() =>
    Promise.resolve(tokenExpiring('ada', now + 30, '-b')),
  );
  const kirora = client({ fetchUserToken });
  // Already within the minute: refreshed once, at once.
  await kirora.identify(tokenExpiring('ada', now + 30));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetchUserToken).toHaveBeenCalledTimes(1);
  kirora.destroy();
});

it('asks for a fresh token as the page is shown again past the refresh time', async () => {
  const listeners: (() => void)[] = [];
  const page = {
    visibilityState: 'visible',
    title: '',
    referrer: '',
    cookie: '',
    querySelector: () => null,
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'visibilitychange') {
        listeners.push(listener);
      }
    },
    removeEventListener: () => undefined,
  };
  vi.stubGlobal('document', page);
  vi.stubGlobal('location', new URL('https://example.com/'));
  vi.stubGlobal('addEventListener', () => undefined);
  vi.stubGlobal('removeEventListener', () => undefined);
  const now = Math.floor(Date.now() / 1000);
  kiroraRefusing(() => false);
  const fetchUserToken = vi.fn(() =>
    Promise.resolve(tokenExpiring('ada', now + 3600, '-fresh')),
  );
  const kirora = client({ fetchUserToken });
  await kirora.identify(tokenExpiring('ada', now + 600));
  expect(fetchUserToken).not.toHaveBeenCalled();

  // The tab was hidden while its timer was held back, and comes back past it.
  page.visibilityState = 'hidden';
  for (const listener of listeners) {
    listener();
  }
  vi.spyOn(Date, 'now').mockReturnValue((now + 590) * 1000);
  page.visibilityState = 'visible';
  for (const listener of listeners) {
    listener();
  }
  expect(fetchUserToken).toHaveBeenCalledTimes(1);
  vi.restoreAllMocks();
  kirora.destroy();
});

it("counts a token's lifetime from its arrival when the device clock is ahead", async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  // Issued an hour ago by the device's clock, which is two hours fast.
  const serverNow = Math.floor(Date.now() / 1000) - 2 * 3600;
  kiroraRefusing(() => false);
  const fetchUserToken = vi.fn(() =>
    Promise.resolve(tokenExpiring('ada', serverNow + 3600, '-fresh', serverNow)),
  );
  const kirora = client({ fetchUserToken });
  await kirora.identify(tokenExpiring('ada', serverNow + 3600, '', serverNow));
  await vi.advanceTimersByTimeAsync(3600_000 - 61_000);
  expect(fetchUserToken).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(fetchUserToken).toHaveBeenCalledTimes(1);
  // The fresh token is counted from its own arrival, not asked for again at once.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchUserToken).toHaveBeenCalledTimes(1);
  kirora.destroy();
});

it('retries a failed early refresh while the token works, telling the app only then', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const now = Math.floor(Date.now() / 1000);
  kiroraRefusing(() => false);
  const failures: AuthenticationFailureReason[] = [];
  let failing = true;
  const fetchUserToken = vi.fn(() =>
    failing
      ? Promise.reject(new Error('offline'))
      : Promise.resolve(tokenExpiring('ada', now + 7200, '-fresh')),
  );
  const kirora = client({
    fetchUserToken,
    onAuthenticationFailed: (reason) => failures.push(reason),
  });
  await kirora.identify(tokenExpiring('ada', now + 3600));
  await vi.advanceTimersByTimeAsync(3600_000 - 59_000);
  expect(fetchUserToken).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(fetchUserToken).toHaveBeenCalledTimes(2);
  expect(failures).toEqual([]);

  failing = false;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(fetchUserToken).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(failures).toEqual([]);
  kirora.destroy();
});

it('tells the app once the token has expired and a refresh still fails', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const now = Math.floor(Date.now() / 1000);
  kiroraRefusing(() => false);
  const failures: AuthenticationFailureReason[] = [];
  const kirora = client({
    fetchUserToken: () => Promise.reject(new Error('offline')),
    onAuthenticationFailed: (reason) => failures.push(reason),
  });
  await kirora.identify(tokenExpiring('ada', now + 3600));
  // Retried while the token works, never reported until it has expired.
  await vi.advanceTimersByTimeAsync(3600_000 - 1_000);
  expect(failures).toEqual([]);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(failures).toEqual(['fetch_failed']);
  kirora.destroy();
});

it("doesn't call onAuthenticationFailed once destroyed", async () => {
  kiroraRefusing(() => true);
  const failures: AuthenticationFailureReason[] = [];
  const kirora = client({ onAuthenticationFailed: (reason) => failures.push(reason) });
  kirora.track('Plan Upgraded');
  await kirora.identify('expired-token');
  await kirora.flush();
  kirora.destroy();
  await tick();
  expect(failures).toEqual([]);
});

it("doesn't tell the app of a failure once someone else has signed in", async () => {
  let answer: (response: Response) => void = () => undefined;
  vi.stubGlobal(
    'fetch',
    (_url: string, init: RequestInit) =>
      new Promise<Response>((resolve) => {
        answer = (response) =>
          resolve(response.status === 401 ? response : accepted(init.body));
      }),
  );
  const failures: AuthenticationFailureReason[] = [];
  const kirora = client({ onAuthenticationFailed: (reason) => failures.push(reason) });
  kirora.track('Plan Upgraded');
  await kirora.identify('alice-token');
  await vi.waitFor(() => expect(answer).not.toBeUndefined());
  answer(new Response(null, { status: 401 }));
  // Bob signs in after Alice's failure is found, before the app is told of it.
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
  await kirora.identify('bob-token');
  await tick();
  expect(failures).toEqual([]);
  kirora.destroy();
});

it('asks at once for a token that arrives with under a minute left', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const now = Math.floor(Date.now() / 1000);
  kiroraRefusing(() => false);
  const fetchUserToken = vi.fn(() =>
    Promise.resolve(tokenExpiring('ada', now + 3600, '-fresh', now)),
  );
  const kirora = client({ fetchUserToken });
  // A cached one-hour token with 30 seconds left.
  await kirora.identify(tokenExpiring('ada', now + 30, '', now - 3570));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fetchUserToken).toHaveBeenCalledTimes(1);
  kirora.destroy();
});

it('sends with the token being refreshed, not the one it replaces', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const now = Math.floor(Date.now() / 1000);
  const tokens = kiroraRefusing((token) => !token.endsWith('-fresh'));
  let giveToken: (token: string) => void = () => undefined;
  const fetchUserToken = vi.fn(
    () => new Promise<string>((resolve) => (giveToken = resolve)),
  );
  const kirora = client({ fetchUserToken });
  await kirora.identify(tokenExpiring('ada', now + 30));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchUserToken).toHaveBeenCalledTimes(1);
  kirora.track('Plan Upgraded');
  const flushed = kirora.flush();
  await vi.advanceTimersByTimeAsync(0);
  expect(tokens).toEqual([]);
  giveToken(tokenExpiring('ada', now + 3600, '-fresh'));
  await flushed;
  expect(tokens).toEqual([tokenExpiring('ada', now + 3600, '-fresh')]);
  kirora.destroy();
});

it('reports a refusal once: through identify() when it rejects for it', async () => {
  // Push is on, so identify() registers this browser with the token, and is refused;
  // the events sent alongside are refused too, but that's the same refusal.
  stubWebPush();
  kiroraRefusing(() => true);
  const failures: AuthenticationFailureReason[] = [];
  const kirora = client({
    push: true,
    onAuthenticationFailed: (reason) => failures.push(reason),
  });
  kirora.track('Plan Upgraded');
  await expect(kirora.identify('expired-token')).rejects.toMatchObject({ status: 401 });
  await kirora.flush();
  await tick();
  expect(failures).toEqual([]);
  kirora.destroy();
});
