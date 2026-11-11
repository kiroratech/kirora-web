import { afterEach, expect, it, vi } from 'vitest';
import { Kirora } from '../src/index.js';
import { accepted } from './fake-kirora.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

it("never lets a fresh token for the previous user replace the next user's", async () => {
  const authorizations: string[] = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    const authorization = new Headers(init.headers).get('authorization')!;
    authorizations.push(authorization);
    if (authorization === 'Bearer expired-token-for-ada') {
      return Promise.resolve(new Response(null, { status: 401 }));
    }
    return Promise.resolve(accepted(init.body));
  });
  let answerTokenFetch: (userToken: string) => void = () => undefined;
  const kirora = new Kirora({
    apiUrl: 'https://api.example.com',
    clientKey: 'kirora_pk_test',
    logLevel: 'none',
    fetchUserToken: () => new Promise((resolve) => (answerTokenFetch = resolve)),
  });

  // Ada's token has expired; the SDK asks the app for a fresh one...
  await kirora.identify('expired-token-for-ada');
  kirora.track('Plan Upgraded');
  const adaFlush = kirora.flush();
  await vi.waitFor(() => expect(authorizations).toHaveLength(1));

  // ...but Grace signs in before the app answers.
  await kirora.identify('token-for-grace');
  answerTokenFetch('fresh-token-for-ada');
  await adaFlush;

  kirora.track('Invoice Paid');
  await kirora.flush();
  expect(authorizations.at(-1)).toBe('Bearer token-for-grace');
});

it('refuses identify() anything but a user token', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    requests.push(`${init.method} ${new URL(url).pathname}`);
    return Promise.resolve(accepted(init.body));
  });
  const kirora = new Kirora({
    clientKey: 'kirora_pk_test',
    trackSessions: false,
    logLevel: 'none',
  });
  const untyped = kirora as unknown as { identify(token: unknown): Promise<void> };
  // The user, or their id, instead of a token signed for them.
  await expect(untyped.identify({ id: 'ada' })).rejects.toMatchObject({
    name: 'KiroraError',
  });
  await expect(untyped.identify('')).rejects.toMatchObject({ name: 'KiroraError' });
  kirora.track('Plan Upgraded');
  await kirora.flush();
  expect(requests).toEqual([]);
});

it('waits for identify() before calls that need the user', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const authorization = new Headers(init.headers).get('authorization');
    calls.push(`${init.method} ${new URL(url).pathname} ${authorization}`);
    return Promise.resolve(
      init.method === 'POST' ? accepted(init.body) : new Response(null, { status: 204 }),
    );
  });
  let answerTokenFetch: (userToken: string) => void = () => undefined;
  const kirora = new Kirora({
    apiUrl: 'https://api.example.com',
    clientKey: 'kirora_pk_test',
    trackSessions: false,
    fetchUserToken: () => new Promise((resolve) => (answerTokenFetch = resolve)),
  });

  // As the script tag replays them: one after another, without waiting.
  kirora.track('Signup Started');
  const identified = kirora.identify();
  const consented = kirora.setPushConsent(true);
  const loggedOut = kirora.logout();
  answerTokenFetch('token-for-ada');
  await Promise.all([identified, consented, loggedOut]);

  expect(calls).toEqual([
    'POST /client/v1/events/batch Bearer token-for-ada',
    'PUT /client/v1/push-consent Bearer token-for-ada',
  ]);
});
