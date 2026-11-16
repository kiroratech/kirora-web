import { afterEach, expect, it, vi } from 'vitest';
import { Kirora } from '../src/index.js';
import { recordEvents, stubLocalStorage, tokenFor } from './fake-kirora.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('tracks nothing until the visitor consents, and forgets what waits when they withdraw', async () => {
  const sent = recordEvents();
  const kirora = new Kirora({
    apiUrl: 'https://api.example.com',
    clientKey: 'kirora_pk_test',
    requireTrackingConsent: true,
  });

  kirora.track('Pricing Viewed');
  kirora.setTrackingConsent(true);
  kirora.track('Signup Started');
  kirora.setTrackingConsent(false);
  kirora.track('Plan Upgraded');
  kirora.setTrackingConsent(true);
  kirora.track('Invoice Paid');

  await kirora.identify('token-for-ada');
  await kirora.flush();
  // Withdrawing ended the session, so consenting again started a new one.
  expect(sent.map((event) => event.name)).toEqual(['Session Started', 'Invoice Paid']);
});

it('forgets the session and device id when consent is withdrawn', async () => {
  const sent = recordEvents();
  const kirora = new Kirora({
    clientKey: 'kirora_pk_test',
    requireTrackingConsent: true,
  });
  await kirora.identify('token-for-ada');

  kirora.setTrackingConsent(true);
  kirora.track('Pricing Viewed');
  await kirora.flush();
  kirora.setTrackingConsent(false);
  kirora.setTrackingConsent(true);
  kirora.track('Pricing Viewed');
  await kirora.flush();

  const [before, after] = [sent[0]!.context, sent.at(-1)!.context];
  expect(after.sessionId).not.toBe(before.sessionId);
  expect(after.device.id).not.toBe(before.device.id);
});

/** Leaves an event queued on the device by a client that didn't require consent. */
async function queueWithoutConsentRequired() {
  stubLocalStorage();
  const earlier = new Kirora({ clientKey: 'kirora_pk_test', trackSessions: false });
  earlier.track('Pricing Viewed');
  await vi.waitFor(() =>
    expect(
      localStorage.getItem('kirora:events:kirora_pk_test@api.kirora.io'),
    ).not.toBeNull(),
  );
  earlier.destroy();
}

function consentClient() {
  return new Kirora({
    clientKey: 'kirora_pk_test',
    trackSessions: false,
    requireTrackingConsent: true,
  });
}

it('sends nothing already queued until the visitor consents', async () => {
  await queueWithoutConsentRequired();
  const sent = recordEvents();
  const kirora = consentClient();

  await kirora.identify(tokenFor('ada'));
  await kirora.flush();
  expect(sent).toEqual([]);

  kirora.setTrackingConsent(true);
  await kirora.flush();
  expect(sent.map((event) => event.name)).toEqual(['Pricing Viewed']);
});

it('forgets what was queued when the visitor has already refused', async () => {
  await queueWithoutConsentRequired();
  localStorage.setItem('kirora:tracking-consent:kirora_pk_test@api.kirora.io', 'refused');
  const sent = recordEvents();
  const kirora = consentClient();

  await kirora.identify(tokenFor('ada'));
  kirora.setTrackingConsent(true);
  await kirora.flush();
  expect(sent).toEqual([]);
});

it('sends nothing more once consent is withdrawn, even mid-send', async () => {
  const sent = recordEvents();
  const kirora = consentClient();
  kirora.setTrackingConsent(true);
  await kirora.identify(tokenFor('ada'));
  kirora.track('Pricing Viewed');

  // The send reads the queue first; consent goes before that read finishes.
  const flushed = kirora.flush();
  kirora.setTrackingConsent(false);
  await flushed;
  expect(sent).toEqual([]);
});

it('honours a refusal even when consent is not required', async () => {
  stubLocalStorage();
  const sent = recordEvents();
  const kirora = new Kirora({ clientKey: 'kirora_pk_test', trackSessions: false });
  await kirora.identify(tokenFor('ada'));

  kirora.setTrackingConsent(false);
  kirora.track('Pricing Viewed');
  await kirora.flush();
  const later = new Kirora({ clientKey: 'kirora_pk_test', trackSessions: false });
  await later.identify(tokenFor('ada'));
  later.track('Pricing Viewed');
  await later.flush();
  expect(sent).toEqual([]);

  later.setTrackingConsent(true);
  later.track('Plan Upgraded');
  await later.flush();
  expect(sent.map((event) => event.name)).toEqual(['Plan Upgraded']);
});

it('collects from the moment of consent, without a page view for the page already open', async () => {
  vi.stubGlobal('location', new URL('https://example.com/pricing'));
  vi.stubGlobal('document', {
    title: 'Pricing',
    referrer: '',
    cookie: '',
    visibilityState: 'visible',
    querySelector: () => null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal('history', { pushState: () => undefined, replaceState: () => undefined });
  vi.stubGlobal('addEventListener', () => undefined);
  vi.stubGlobal('removeEventListener', () => undefined);
  const sent = recordEvents();
  const kirora = new Kirora({
    clientKey: 'kirora_pk_test',
    requireTrackingConsent: true,
    trackPageViews: true,
    logLevel: 'none',
  });
  kirora.setTrackingConsent(true);
  kirora.track('Plan Compared');
  await kirora.identify(tokenFor('ada'));
  await kirora.flush();
  expect(sent.map((event) => event.name)).toEqual(['Session Started', 'Plan Compared']);
  kirora.destroy();
});

it('tracks nothing it cannot be sure was not refused, until consent is given anew', async () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new DOMException('Blocked', 'SecurityError');
    },
    setItem: () => {
      throw new DOMException('Blocked', 'SecurityError');
    },
    removeItem: () => undefined,
  });
  const sent = recordEvents();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const kirora = new Kirora({ clientKey: 'kirora_pk_test', trackSessions: false });
  await kirora.identify(tokenFor('ada'));
  kirora.track('Pricing Viewed');
  await kirora.flush();
  expect(sent).toEqual([]);

  kirora.setTrackingConsent(true);
  kirora.track('Plan Upgraded');
  await kirora.flush();
  expect(sent.map((event) => event.name)).toEqual(['Plan Upgraded']);
  expect(errors.mock.calls.map(([message]) => String(message)).join('\n')).toContain(
    "Can't save the tracking choice",
  );
  errors.mockRestore();
  kirora.destroy();
});

it('cancels a batch already on its way when consent is withdrawn', async () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    signal = init.signal ?? undefined;
    return new Promise<Response>((_, reject) =>
      signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError'))),
    );
  });
  const kirora = new Kirora({
    clientKey: 'kirora_pk_test',
    trackSessions: false,
    logLevel: 'none',
  });
  await kirora.identify(tokenFor('ada'));
  kirora.track('Pricing Viewed');
  const flushed = kirora.flush();
  await vi.waitFor(() => expect(signal).toBeDefined());
  kirora.setTrackingConsent(false);
  await flushed;
  expect(signal!.aborted).toBe(true);
  kirora.destroy();
});

it('stops trusting a saved grant once storage stops taking writes', async () => {
  let full = false;
  stubLocalStorage(() => full);
  const key = 'kirora:tracking-consent:kirora_pk_test@api.kirora.io';
  localStorage.setItem(key, 'granted');
  const sent = recordEvents();
  const kirora = new Kirora({
    clientKey: 'kirora_pk_test',
    requireTrackingConsent: true,
    trackSessions: false,
    logLevel: 'none',
  });
  await kirora.identify(tokenFor('ada'));
  kirora.track('Pricing Viewed');
  await kirora.flush();
  expect(sent.map((event) => event.name)).toEqual(['Pricing Viewed']);

  // The quota fills: the next write fails, and the events in it are kept in memory.
  full = true;
  kirora.track('Plan Compared');
  await kirora.flush();
  // From then on, the saved grant no longer counts, here or on later pages.
  kirora.track('Invoice Paid');
  await kirora.flush();
  expect(localStorage.getItem(key)).toBeNull();

  kirora.setTrackingConsent(true);
  kirora.track('Plan Upgraded');
  await kirora.flush();
  expect(sent.map((event) => event.name)).toEqual([
    'Pricing Viewed',
    'Plan Compared',
    'Plan Upgraded',
  ]);
  kirora.destroy();
});
