import { afterEach, expect, it, vi } from 'vitest';
import type { Kirora, KiroraOptions } from '../src/index.js';
import { fakeKirora, tokenFor, type SentRequest } from './fake-kirora.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

type Call = [
  method: string,
  args: unknown[],
  held: { at: number; href: string; title: string },
];

/** What the README's loader snippet leaves on `window.kirora`, with these calls queued. */
function loaderSnippet(options: KiroraOptions, calls: [string, ...unknown[]][]) {
  const held = () => ({ at: Date.now(), href: 'https://example.com/', title: 'Home' });
  const queue =
    (method: string) =>
    (...args: unknown[]) =>
      void snippet.push([method, args, held()]);
  const snippet = Object.assign([] as Call[], {
    options,
    start: held(),
    identify: queue('identify'),
    logout: queue('logout'),
    track: queue('track'),
  });
  for (const [method, ...args] of calls) snippet.push([method, args, held()]);
  return snippet;
}

/** Loads the script-tag build over `snippet`, as the CDN script would. */
async function loadCdn(snippet: unknown) {
  vi.resetModules();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('kirora', snippet);
  await import('../src/cdn.js');
}

/** The SDK, once the backlog has been replayed and `window.kirora` is the SDK. */
async function replayed(): Promise<Kirora> {
  const current = () => (globalThis as unknown as { kirora: unknown }).kirora;
  await vi.waitFor(() => expect(Array.isArray(current())).toBe(false));
  return current() as Kirora;
}

const batches = (requests: SentRequest[]) =>
  requests
    .filter((request) => request.path === '/events/batch')
    .map((request) => [
      request.user,
      (request.body as { events: { name: string }[] }).events.map((event) => event.name),
    ]);

it('replays each queued call once the one before it has finished', async () => {
  const server = fakeKirora();
  let answerAlice: (token: string) => void = () => undefined;
  const snippet = loaderSnippet(
    {
      clientKey: 'kirora_pk_a',
      trackSessions: false,
      fetchUserToken: () => new Promise((resolve) => (answerAlice = resolve)),
    },
    [['identify'], ['track', 'Alice Event'], ['identify', tokenFor('bob')]],
  );

  await loadCdn(snippet);
  // Made by the page while the backlog replays: it waits its turn.
  snippet.track('Bob Event');
  answerAlice(tokenFor('alice'));
  const kirora = await replayed();
  await kirora.flush();
  await kirora.identify(tokenFor('alice'));
  await kirora.flush();

  expect(batches(server.requests)).toEqual([
    ['bob', ['Bob Event']],
    ['alice', ['Alice Event']],
  ]);
});

it('replays a logout before the calls after it, and carries on past a failed call', async () => {
  const server = fakeKirora();
  const failed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const snippet = loaderSnippet(
    {
      clientKey: 'kirora_pk_a',
      trackSessions: false,
      logLevel: 'none',
      fetchUserToken: () => Promise.reject(new Error('signed out')),
    },
    [
      ['identify', tokenFor('alice')],
      ['track', 'Invoice Paid'],
      ['logout'],
      ['track', 'Pricing Viewed'],
      ['identify'],
      ['identify', tokenFor('bob')],
    ],
  );

  await loadCdn(snippet);
  const kirora = await replayed();
  await kirora.flush();

  expect(batches(server.requests)).toEqual([
    ['alice', ['Invoice Paid']],
    ['bob', ['Pricing Viewed']],
  ]);
  expect(failed).toHaveBeenCalledWith('Kirora: identify failed', expect.anything());
  failed.mockRestore();
});

it('still takes calls made through the snippet once the backlog has replayed', async () => {
  const server = fakeKirora();
  const snippet = loaderSnippet({ clientKey: 'kirora_pk_a', trackSessions: false }, [
    ['identify', tokenFor('alice')],
  ]);

  await loadCdn(snippet);
  const kirora = await replayed();
  // Through a reference to the snippet the page kept from before the script loaded.
  snippet.track('Late Event');
  await kirora.flush();
  snippet.identify(tokenFor('bob'));
  snippet.track('Bob Event');
  await kirora.flush();

  expect(batches(server.requests)).toEqual([
    ['alice', ['Late Event']],
    ['bob', ['Bob Event']],
  ]);
});
