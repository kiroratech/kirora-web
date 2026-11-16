import { afterEach, expect, it, vi } from 'vitest';
import { Kirora, type KiroraOptions } from '../src/index.js';
import { accepted, recordEvents, tokenFor } from './fake-kirora.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A page at `href`, with what the SDK reads of it. */
function stubPage(href: string, visibilityState = 'visible') {
  const page = {
    title: 'Page',
    referrer: '',
    cookie: '',
    visibilityState,
    querySelector: () => null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  vi.stubGlobal('location', new URL(href));
  vi.stubGlobal('document', page);
  vi.stubGlobal('addEventListener', () => undefined);
  vi.stubGlobal('removeEventListener', () => undefined);
  return page;
}

function client(options: Partial<KiroraOptions> = {}) {
  return new Kirora({
    clientKey: 'kirora_pk_a',
    trackSessions: false,
    logLevel: 'none',
    ...options,
  });
}

it.each([
  ['NaN', { score: Number.NaN }],
  ['Infinity', { score: Infinity }],
  ['a function', { onClick: () => undefined }],
  ['a Map', { items: new Map([['a', 1]]) }],
  ['a bigint', { total: BigInt(1) }],
  ['undefined in an array', { tags: ['a', undefined] }],
])(
  'drops an event whose properties hold %s, and tracks the next',
  async (_, properties) => {
    const sent = recordEvents();
    const kirora = client();
    kirora.track('Broken', properties);
    kirora.track('Invoice Paid');
    await kirora.identify(tokenFor('ada'));
    await kirora.flush();
    expect(sent.map((event) => event.name)).toEqual(['Invoice Paid']);
  },
);

it('drops a circular event without logging its properties', async () => {
  const sent = recordEvents();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const kirora = client({ logLevel: 'error' });
  const properties: Record<string, unknown> = { secret: 'hunter2' };
  properties.self = properties;
  kirora.track('Broken', properties);
  await kirora.identify(tokenFor('ada'));
  await kirora.flush();
  expect(sent).toEqual([]);
  expect(JSON.stringify(errors.mock.calls)).not.toContain('hunter2');
});

it('sends dates as JSON writes them, and leaves out members that are undefined', async () => {
  const sent = recordEvents();
  const kirora = client();
  kirora.track('Invoice Paid', {
    paidAt: new Date(Date.UTC(2026, 10, 16)),
    coupon: undefined,
    shared: [{ a: 1 }, { a: 1 }],
  });
  await kirora.identify(tokenFor('ada'));
  await kirora.flush();
  expect(sent[0]!.properties).toEqual({
    paidAt: '2026-11-16T00:00:00.000Z',
    shared: [{ a: 1 }, { a: 1 }],
  });
});

it('drops an event too large for the queue, keeping those before it', async () => {
  const sent = recordEvents();
  const kirora = client();
  kirora.track('Invoice Paid');
  // Two bytes a character in UTF-8, so over the 1,000,000-byte budget.
  kirora.track('Document Saved', { text: 'é'.repeat(500_001) });
  await kirora.identify(tokenFor('ada'));
  await kirora.flush();
  expect(sent.map((event) => event.name)).toEqual(['Invoice Paid']);
});

it('redacts every event before it is stored, Session Started included', async () => {
  const sent = recordEvents();
  stubPage('https://example.com/reset?token=secret&page=2');
  const kirora = client({
    trackSessions: true,
    beforeSend: (event) => {
      const strip = (url: unknown) =>
        typeof url === 'string' ? url.replace(/token=[^&]*/, 'token=') : url;
      const page = event.context.page as Record<string, unknown> | undefined;
      if (page) {
        page.url = strip(page.url);
        page.search = strip(page.search);
      }
      event.properties = Object.fromEntries(
        Object.entries(event.properties).map(([key, value]) => [key, strip(value)]),
      );
      return event;
    },
  });
  kirora.trackPageView();
  kirora.track('Password Reset', { link: 'https://example.com/reset?token=secret' });

  await vi.waitFor(() =>
    expect(
      localStorage.getItem('kirora:events:kirora_pk_a@api.kirora.io'),
    ).not.toBeNull(),
  );
  expect(localStorage.getItem('kirora:events:kirora_pk_a@api.kirora.io')).not.toContain(
    'secret',
  );
  await kirora.identify(tokenFor('ada'));
  await kirora.flush();
  expect(sent.map((event) => event.name)).toEqual([
    'Session Started',
    'Page Viewed',
    'Password Reset',
  ]);
  expect(JSON.stringify(sent)).not.toContain('secret');
  kirora.destroy();
});

it.each([
  ['answers null', () => null],
  [
    'throws',
    () => {
      throw new Error('hunter2');
    },
  ],
  ['answers later', () => Promise.resolve(null)],
  ['answers something other than an event', () => 'hunter2'],
  [
    'answers values JSON cannot hold',
    () => ({ properties: { score: NaN }, context: {} }),
  ],
])('drops the event when beforeSend %s, without logging it', async (_, beforeSend) => {
  const sent = recordEvents();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const kirora = client({
    logLevel: 'error',
    beforeSend: beforeSend as unknown as KiroraOptions['beforeSend'],
  });
  kirora.track('Password Reset', { secret: 'hunter2' });
  await kirora.identify(tokenFor('ada'));
  await kirora.flush();
  expect(sent).toEqual([]);
  expect(JSON.stringify(errors.mock.calls)).not.toContain('hunter2');
});

it('keeps the name, time and idempotency key its own, whatever beforeSend answers', async () => {
  const sent = recordEvents();
  const kirora = client({
    beforeSend: () =>
      ({
        name: 'Renamed',
        idempotencyKey: 'mine',
        properties: { plan: 'pro' },
        context: {},
      }) as never,
  });
  kirora.track('Plan Upgraded', { plan: 'pro', card: '4242' });
  await kirora.identify(tokenFor('ada'));
  await kirora.flush();
  expect(sent).toEqual([
    expect.objectContaining({
      name: 'Plan Upgraded',
      properties: { plan: 'pro' },
      context: {},
    }),
  ]);
  expect((sent[0] as unknown as { idempotencyKey: string }).idempotencyKey).not.toBe(
    'mine',
  );
});

it('refuses tracking from inside beforeSend rather than recursing', async () => {
  const sent = recordEvents();
  let calls = 0;
  const kirora: Kirora = client({
    beforeSend: (event) => {
      calls++;
      kirora.track('From The Hook');
      return event;
    },
  });
  kirora.track('Plan Upgraded');
  await kirora.identify(tokenFor('ada'));
  await kirora.flush();
  expect(calls).toBe(1);
  expect(sent.map((event) => event.name)).toEqual(['Plan Upgraded']);
});

it('retries events refused for a passing reason, or answered twice, and drops the rest', async () => {
  const answers: Record<string, string>[] = [];
  let attempt = 0;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    attempt++;
    const { events } = JSON.parse(String(init.body)) as {
      events: { idempotencyKey: string; name: string }[];
    };
    answers.push(
      Object.fromEntries(events.map((event) => [event.name, String(attempt)])),
    );
    if (attempt > 1) return Promise.resolve(accepted({ events }));
    const key = (name: string) =>
      events.find((event) => event.name === name)!.idempotencyKey;
    return Promise.resolve(
      Response.json({
        data: {
          results: [
            { idempotencyKey: key('Accepted') },
            { idempotencyKey: key('Limited'), error: { code: 'RATE_LIMITED' } },
            { idempotencyKey: key('Failed'), error: { code: 'INTERNAL_ERROR' } },
            { idempotencyKey: key('Over'), error: { code: 'PLAN_LIMIT_REACHED' } },
            { idempotencyKey: key('Twice') },
            { idempotencyKey: key('Twice'), error: { code: 'VALIDATION_ERROR' } },
          ],
        },
      }),
    );
  });
  const kirora = client();
  for (const name of ['Accepted', 'Limited', 'Failed', 'Over', 'Twice'])
    kirora.track(name);
  await kirora.identify(tokenFor('ada'));
  await kirora.flush();
  await kirora.flush();
  expect(Object.keys(answers[1]!)).toEqual(['Limited', 'Failed', 'Twice']);
});

it('keeps an event too large for keepalive while the page is hidden', async () => {
  const sent = recordEvents();
  const page = stubPage('https://example.com/', 'hidden');
  const kirora = client();
  kirora.track('Document Saved', { text: 'x'.repeat(70_000) });
  await kirora.identify(tokenFor('ada'));
  await kirora.flush();
  expect(sent).toEqual([]);

  page.visibilityState = 'visible';
  await kirora.flush();
  expect(sent.map((event) => event.name)).toEqual(['Document Saved']);
  kirora.destroy();
});
