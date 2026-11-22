import { afterEach, expect, it, vi } from 'vitest';
import { Kirora } from '../src/index.js';
import {
  memoryStorage,
  recordEvents,
  stubLocalStorage,
  tokenFor,
} from './fake-kirora.js';

const CONSENT_KEY = 'kirora:tracking-consent:kirora_pk_test@api.kirora.io';
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
  localStorage.setItem(CONSENT_KEY, 'refused');
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
  const key = CONSENT_KEY;
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
  // From then on, the saved grant no longer counts here; it's ignored, not deleted.
  kirora.track('Invoice Paid');
  await kirora.flush();
  expect(localStorage.getItem(key)).toBe('granted');

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

const REFUSAL_KEY = 'kirora:tracking-refused:kirora_pk_test@api.kirora.io';

/** Tracks one event with a fresh client, returning what reached Kirora. */
async function trackOnce(options: { requireTrackingConsent?: boolean } = {}) {
  const sent = recordEvents();
  const kirora = new Kirora({
    clientKey: 'kirora_pk_test',
    trackSessions: false,
    logLevel: 'none',
    ...options,
  });
  await kirora.identify(tokenFor('ada'));
  kirora.track('Pricing Viewed');
  await kirora.flush();
  kirora.destroy();
  return sent.map((event) => event.name);
}

/** One browser's `localStorage`, whose reads and writes `faults` can make throw. */
function faultyStorage() {
  /** `full`: writes fail but removals work, as with a full quota. */
  const faults: { read: boolean; write: (key: string) => boolean; full: boolean } = {
    read: false,
    write: () => false,
    full: false,
  };
  const disk = memoryStorage(() => faults.full);
  const removed: string[] = [];
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => {
      if (faults.read) {
        throw new DOMException('Blocked', 'SecurityError');
      }
      return disk.getItem(key);
    },
    setItem: (key: string, value: string) => {
      if (faults.write(key)) {
        throw new DOMException('Failed', 'UnknownError');
      }
      disk.setItem(key, value);
    },
    removeItem: (key: string) => {
      if (faults.write(key)) {
        throw new DOMException('Failed', 'UnknownError');
      }
      removed.push(key);
      disk.removeItem(key);
    },
  });
  return { disk, removed, faults };
}

it('removes a saved grant when a refusal can only be kept in memory', async () => {
  const { disk, faults } = faultyStorage();
  const kirora = new Kirora({
    clientKey: 'kirora_pk_test',
    requireTrackingConsent: true,
    logLevel: 'none',
  });
  kirora.setTrackingConsent(true);
  faults.full = true;
  kirora.setTrackingConsent(false);
  kirora.destroy();
  expect(disk.getItem(CONSENT_KEY)).toBeNull();

  // The next page, with room again, doesn't find the old grant.
  faults.full = false;
  expect(await trackOnce({ requireTrackingConsent: true })).toEqual([]);
});

it('keeps a refusal in two places, and a later grant clears both', () => {
  stubLocalStorage();
  const kirora = new Kirora({ clientKey: 'kirora_pk_test', logLevel: 'none' });
  kirora.setTrackingConsent(false);
  expect(localStorage.getItem(CONSENT_KEY)).toBe('refused');
  expect(localStorage.getItem(REFUSAL_KEY)).toBe('refused');

  kirora.setTrackingConsent(true);
  expect(localStorage.getItem(CONSENT_KEY)).toBe('granted');
  expect(localStorage.getItem(REFUSAL_KEY)).toBeNull();
  kirora.destroy();
});

it.each([
  ['garbled', 'gr@nted'],
  ['lost', null],
])('keeps a refusal whose answer was %s, consent required or not', async (_, value) => {
  for (const requireTrackingConsent of [false, true]) {
    stubLocalStorage();
    new Kirora({ clientKey: 'kirora_pk_test', logLevel: 'none' }).setTrackingConsent(
      false,
    );
    if (value === null) {
      localStorage.removeItem(CONSENT_KEY);
    } else {
      localStorage.setItem(CONSENT_KEY, value);
    }

    expect(await trackOnce({ requireTrackingConsent })).toEqual([]);
  }
});

it('keeps a refusal whose copy was lost, writing nothing back', async () => {
  stubLocalStorage();
  localStorage.setItem(CONSENT_KEY, 'refused');
  expect(await trackOnce()).toEqual([]);
  // Only setTrackingConsent writes either copy.
  expect(localStorage.getItem(REFUSAL_KEY)).toBeNull();
});

it('tracks as on a first visit when the answer is garbled and no refusal is on record', async () => {
  stubLocalStorage();
  localStorage.setItem(CONSENT_KEY, '{"granted":');
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const sent = recordEvents();
  const kirora = new Kirora({ clientKey: 'kirora_pk_test', trackSessions: false });
  await kirora.identify(tokenFor('ada'));
  kirora.track('Pricing Viewed');
  await kirora.flush();
  expect(sent.map((event) => event.name)).toEqual(['Pricing Viewed']);
  expect(errors.mock.calls.map(([message]) => String(message)).join('\n')).toContain(
    "Can't read the saved tracking choice",
  );
  errors.mockRestore();
  kirora.destroy();
});

it('never assumes a grant from a garbled answer when consent is required', async () => {
  stubLocalStorage();
  localStorage.setItem(CONSENT_KEY, 'grante');
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const sent = recordEvents();
  const kirora = consentClient();
  await kirora.identify(tokenFor('ada'));
  kirora.track('Pricing Viewed');
  await kirora.flush();
  expect(sent).toEqual([]);
  expect(errors.mock.calls.map(([message]) => String(message)).join('\n')).toContain(
    "Can't read the saved tracking choice",
  );

  kirora.setTrackingConsent(true);
  kirora.track('Plan Upgraded');
  await kirora.flush();
  expect(sent.map((event) => event.name)).toEqual(['Plan Upgraded']);
  expect(localStorage.getItem(CONSENT_KEY)).toBe('granted');
  errors.mockRestore();
  kirora.destroy();
});

it('lets a grant take effect even when the refusal copy cannot be removed', async () => {
  const { faults } = faultyStorage();
  new Kirora({ clientKey: 'kirora_pk_test', logLevel: 'none' }).setTrackingConsent(false);
  faults.write = (key) => key === REFUSAL_KEY;
  const sent = recordEvents();
  const kirora = new Kirora({
    clientKey: 'kirora_pk_test',
    trackSessions: false,
    logLevel: 'none',
  });
  await kirora.identify(tokenFor('ada'));
  kirora.setTrackingConsent(true);
  kirora.track('Plan Upgraded');
  await kirora.flush();
  expect(sent.map((event) => event.name)).toEqual(['Plan Upgraded']);
  kirora.destroy();
});

it('leaves a stored refusal alone while storage cannot be read', async () => {
  const { disk, removed, faults } = faultyStorage();
  new Kirora({ clientKey: 'kirora_pk_test', logLevel: 'none' }).setTrackingConsent(false);
  // Reads fail but deletes still work, as when Android lost its refusal.
  faults.read = true;

  for (const requireTrackingConsent of [false, true]) {
    expect(await trackOnce({ requireTrackingConsent })).toEqual([]);
  }
  expect(removed).not.toContain(CONSENT_KEY);
  expect(removed).not.toContain(REFUSAL_KEY);
  expect(disk.getItem(CONSENT_KEY)).toBe('refused');
  expect(disk.getItem(REFUSAL_KEY)).toBe('refused');

  faults.read = false;
  expect(await trackOnce()).toEqual([]);
});

it.each([
  ['a refusal', false],
  ['a grant', true],
])(
  'never loses a refusal when the page stops between the writes of %s',
  async (_, granted) => {
    const { faults } = faultyStorage();
    const client = () => new Kirora({ clientKey: 'kirora_pk_test', logLevel: 'none' });
    if (granted) {
      client().setTrackingConsent(false);
    }
    const kirora = client();
    // The first write reaches the disk; the page "stops" before the second does.
    let writes = 0;
    faults.write = () => writes++ > 0;
    kirora.setTrackingConsent(granted);
    faults.write = () => false;

    // The next page sees a refusal: the new one mid-refusal, the old one mid-grant.
    expect(await trackOnce()).toEqual([]);
  },
);

it("doesn't undo a grant another tab is in the middle of saving", async () => {
  stubLocalStorage();
  new Kirora({ clientKey: 'kirora_pk_test', logLevel: 'none' }).setTrackingConsent(false);
  const other = new Kirora({ clientKey: 'kirora_pk_test', logLevel: 'none' });
  // A grant elsewhere has cleared the copy but not yet written the answer.
  localStorage.removeItem(REFUSAL_KEY);
  other.track('Pricing Viewed');
  localStorage.setItem(CONSENT_KEY, 'granted');

  expect(await trackOnce()).toEqual(['Pricing Viewed']);
  other.destroy();
});

it("keeps each deployment's answer apart, path and all", () => {
  stubLocalStorage();
  const client = (apiUrl: string) =>
    new Kirora({ apiUrl, clientKey: 'kirora_pk_test', logLevel: 'none' });
  // Kept under the deployment's path, without the trailing slash.
  client('https://api.example.com/eu/').setTrackingConsent(false);
  expect(
    localStorage.getItem('kirora:tracking-consent:kirora_pk_test@api.example.com/eu'),
  ).toBe('refused');
  // Another path on the same host is another deployment.
  expect(
    localStorage.getItem('kirora:tracking-consent:kirora_pk_test@api.example.com'),
  ).toBe(null);
});
