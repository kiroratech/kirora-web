import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { Kirora } from '../src/index.js';

/**
 * Against a real Kirora API: a workspace's client key and token secret, from its
 * Developer → SDK page. Skipped without them.
 */
const apiUrl = process.env.KIRORA_API_URL;
const clientKey = process.env.KIRORA_CLIENT_KEY;
const tokenSecret = process.env.KIRORA_TOKEN_SECRET;

/** What the customer's server does at sign-in. */
function signUserToken(sub: string, lifetimeSeconds: number) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const encode = (part: unknown) =>
    Buffer.from(JSON.stringify(part)).toString('base64url');
  const signingInput = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub,
    iat: nowSeconds,
    exp: nowSeconds + lifetimeSeconds,
  })}`;
  const signature = createHmac('sha256', tokenSecret!)
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

it.skipIf(!apiUrl || !clientKey || !tokenSecret)(
  'holds events until sign-in, replaces an expired token, and forgets the user at sign-out',
  async () => {
    const calls: { path: string; status: number; authorization: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await realFetch(input, init);
      calls.push({
        path: new URL(String(input)).pathname,
        status: response.status,
        authorization: new Headers(init?.headers).get('authorization') ?? '',
      });
      return response;
    };
    try {
      const freshToken = signUserToken('web-sdk-test-user', 3600);
      const kirora = new Kirora({
        apiUrl: apiUrl!,
        clientKey: clientKey!,
        logLevel: 'none',
        fetchUserToken: () => Promise.resolve(freshToken),
      });

      kirora.track('Test Event Tracked', { step: 1 });
      await kirora.flush();
      expect(calls).toHaveLength(0);

      // An expired token is refused; a fresh one is fetched and the call made again.
      await kirora.identify(signUserToken('web-sdk-test-user', -10));
      await kirora.flush();
      expect(calls).toEqual([
        {
          path: '/client/v1/events/batch',
          status: 401,
          authorization: expect.any(String),
        },
        {
          path: '/client/v1/events/batch',
          status: 200,
          authorization: `Bearer ${freshToken}`,
        },
      ]);

      await kirora.setPushConsent(false);
      await kirora.logout();
      kirora.track('Test Event Tracked', { step: 2 });
      await kirora.flush();
      expect(calls.map(({ path, status }) => [path, status]).slice(2)).toEqual([
        ['/client/v1/push-consent', 204],
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  },
);
