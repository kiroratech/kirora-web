import { afterEach, expect, it, vi } from 'vitest';
import * as sdk from '../src/index.js';
import { Kirora, KiroraApiError, KiroraError, UserTokenError } from '../src/index.js';
import { fakeKirora, pushClient, stubWebPush, tokenFor } from './fake-kirora.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('throws only KiroraErrors, so apps can catch them all at once', async () => {
  const kirora = new Kirora({ clientKey: 'kirora_pk_test', logLevel: 'none' });
  await expect(kirora.identify()).rejects.toBeInstanceOf(KiroraError);
  await expect(kirora.setPushConsent(true)).rejects.toBeInstanceOf(KiroraError);
  expect(new KiroraApiError(429, undefined, 'Slow down')).toBeInstanceOf(KiroraError);
  expect(new UserTokenError(new Error('offline'))).toBeInstanceOf(KiroraError);
});

it('logs what a malformed apiUrl should look like, without breaking the page', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const kirora = new Kirora({ clientKey: 'kirora_pk_test', apiUrl: 'api.kirora.io' });
  const expected = /apiUrl must be an address like https:\/\/api\.kirora\.io/;
  expect(errors).toHaveBeenCalledWith(expect.stringMatching(expected));

  kirora.track('Invoice Paid');
  await expect(kirora.identify('token')).rejects.toThrow(expected);
  await expect(kirora.identify('token')).rejects.toBeInstanceOf(KiroraError);
  await kirora.flush();
  await expect(kirora.setPushConsent(true)).rejects.toThrow(expected);
  expect(fetch).not.toHaveBeenCalled();
  errors.mockRestore();
});

it('warns about a client key that is missing or not one', () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  new Kirora({ clientKey: '' });
  expect(errors).toHaveBeenCalledWith(expect.stringContaining('kirora_pk_'));
  errors.mockRestore();
});

it('offers script-tag sites the same exports as the npm package', async () => {
  vi.stubGlobal('window', {});
  await import('../src/cdn.js');
  const { init, ...exports } = (window as unknown as { Kirora: Record<string, unknown> })
    .Kirora;
  expect(Object.keys(exports).sort()).toEqual(Object.keys(sdk).sort());
  expect(init).toBeTypeOf('function');
});

it.each(['api.kirora.io:443', 'localhost:3000', 'ftp://api.kirora.io'])(
  'refuses an apiUrl without http or https, such as %s',
  (apiUrl) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    new Kirora({ clientKey: 'kirora_pk_test', apiUrl });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('apiUrl must be'));
    errors.mockRestore();
  },
);

it.each([undefined, null, 'kirora_pk_test', { clientKey: 123 }])(
  'never throws from the constructor, even given %j',
  (options) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => new Kirora(options as never)).not.toThrow();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('kirora_pk_'));
    errors.mockRestore();
  },
);

it('logs nothing while server rendering, where there is no localStorage', () => {
  vi.stubGlobal('localStorage', undefined);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  new Kirora({ clientKey: 'kirora_pk_test' }).track('Signup Started');
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

it('turns a call that could not reach Kirora into a KiroraError, keeping the cause', async () => {
  const offline = new TypeError('Failed to fetch');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(offline));
  const kirora = new Kirora({ clientKey: 'kirora_pk_test', logLevel: 'none' });
  await kirora.identify(tokenFor('u'));
  const error = await kirora.setPushConsent(true).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(KiroraError);
  expect(error).not.toBeInstanceOf(KiroraApiError);
  expect((error as KiroraError).cause).toBe(offline);
});

it('rejects with a KiroraError for an aborted call too', async () => {
  const aborted = new DOMException('Aborted', 'AbortError');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(aborted));
  const kirora = new Kirora({ clientKey: 'kirora_pk_test', logLevel: 'none' });
  await kirora.identify(tokenFor('u'));
  const error = await kirora.setPushConsent(true).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(KiroraError);
  expect((error as KiroraError).cause).toBe(aborted);
});

it('rejects setPushConsent when Kirora refuses it', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Down' } }),
        {
          status: 500,
        },
      ),
    ),
  );
  const kirora = new Kirora({ clientKey: 'kirora_pk_test', logLevel: 'none' });
  await kirora.identify(tokenFor('u'));
  await expect(kirora.setPushConsent(true)).rejects.toBeInstanceOf(KiroraApiError);
});

it("answers requestPushPermission even when the browser can't subscribe", async () => {
  const refused = new DOMException('Registration failed', 'AbortError');
  stubWebPush(Promise.reject(refused));
  fakeKirora();
  vi.stubGlobal('Notification', {
    permission: 'default',
    requestPermission: () => Promise.resolve('granted'),
  });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const kirora = pushClient({ logLevel: 'error' });
  await kirora.identify(tokenFor('alice'));
  vi.stubGlobal('Notification', {
    permission: 'granted',
    requestPermission: () => Promise.resolve('granted'),
  });
  // The answer stands; the failure is logged, and the status says it isn't registered.
  expect(await kirora.requestPushPermission()).toBe('granted');
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("Couldn't register this browser"),
    refused,
  );
  expect(await kirora.getPushStatus()).toBe('disabled');
  errors.mockRestore();
  kirora.destroy();
});
