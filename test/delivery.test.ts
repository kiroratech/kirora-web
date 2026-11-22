import { afterEach, expect, it, vi } from 'vitest';
import { Kirora } from '../src/index.js';
import { accepted, kiroraRefusing, stubLocalStorage, tokenFor } from './fake-kirora.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

type SentBatch = { events: { name: string; properties: { note?: string } }[] };

/** A Kirora that answers each batch with `answer`, recording what it was sent. */
function kiroraAnswering(answer: (batch: SentBatch) => Response | Promise<Response>) {
  const batches: SentBatch[] = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    const batch = JSON.parse(String(init.body)) as SentBatch;
    batches.push(batch);
    return Promise.resolve(answer(batch));
  });
  const kirora = new Kirora({
    clientKey: 'kirora_pk_test',
    trackSessions: false,
    logLevel: 'none',
  });
  return { kirora, batches };
}

const names = (batch: SentBatch) => batch.events.map((event) => event.name);

/** Kirora refusing `batch` for the first event with a note, naming its field. */
function refusingNote(batch: SentBatch, status = 400): Response {
  const index = batch.events.findIndex((event) => event.properties.note);
  return Response.json(
    {
      error: {
        code: 'VALIDATION_ERROR',
        errors: [{ in: 'body', field: `events.${index}.properties.note` }],
      },
    },
    { status },
  );
}

it('drops a batch Kirora refuses as it is, so the events behind it still go', async () => {
  let refused = false;
  const { kirora, batches } = kiroraAnswering((batch) => {
    if (refused) return accepted(batch);
    refused = true;
    return Response.json(
      { error: { code: 'PLAN_FEATURE_UNAVAILABLE' } },
      { status: 403 },
    );
  });
  for (let index = 0; index < 101; index++) kirora.track(`Event ${index}`);

  await kirora.identify('token-for-ada');
  await kirora.flush();
  expect(batches.map((batch) => batch.events.length)).toEqual([100, 1]);
  expect(names(batches[1]!)).toEqual(['Event 100']);
  // Nothing left to send again.
  await kirora.flush();
  expect(batches).toHaveLength(2);
});

it.each([403, 404, 409])(
  'keeps the events when something other than Kirora answers %i, and retries later',
  async (status) => {
    let answer = status;
    const { kirora, batches } = kiroraAnswering((batch) =>
      answer === 200 ? accepted(batch) : new Response('Not here', { status: answer }),
    );
    kirora.track('Plan Upgraded');
    kirora.track('Invoice Paid');

    await kirora.identify('token-for-ada');
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    // Backing off: nothing goes until the delay has passed, or the app flushes.
    kirora.track('Report Exported');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(batches).toHaveLength(1);

    answer = 200;
    await kirora.flush();
    expect(batches.at(-1)!.events.map((event) => event.name)).toEqual([
      'Plan Upgraded',
      'Invoice Paid',
      'Report Exported',
    ]);
  },
);

it.each([400, 422])(
  'sends a batch refused %i in halves, dropping only the event named',
  async (status) => {
    const { kirora, batches } = kiroraAnswering((batch) =>
      batch.events.some((event) => event.properties.note)
        ? refusingNote(batch, status)
        : accepted(batch),
    );
    kirora.track('Plan Compared');
    kirora.track('Note Saved', { note: 'invalid' });
    kirora.track('Invoice Paid');

    await kirora.identify('token-for-ada');
    await kirora.flush();
    const delivered = batches.filter((batch) => !names(batch).includes('Note Saved'));
    expect(delivered.flatMap(names)).toEqual(['Plan Compared', 'Invoice Paid']);
  },
);

it.each(
  [400, 422].flatMap((status) =>
    [
      ['no errors', { code: 'VALIDATION_ERROR' }],
      [
        'a header',
        { code: 'VALIDATION_ERROR', errors: [{ in: 'headers', field: 'kirora-sdk' }] },
      ],
      ['a query', { code: 'VALIDATION_ERROR', errors: [{ in: 'query', field: 'x' }] }],
    ].map(([what, error]) => [status, what, error] as const),
  ),
)(
  'keeps the events for a %i naming %s, a problem with the request',
  async (status, _, error) => {
    let answer = status;
    const { kirora, batches } = kiroraAnswering((batch) =>
      answer === 200 ? accepted(batch) : Response.json({ error }, { status: answer }),
    );
    kirora.track('Plan Compared');
    kirora.track('Invoice Paid');
    await kirora.identify('token-for-ada');
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Not split: the whole batch waits for a retry.
    expect(batches).toHaveLength(1);

    answer = 200;
    await kirora.flush();
    expect(names(batches.at(-1)!)).toEqual(['Plan Compared', 'Invoice Paid']);
  },
);

it('never queues an event without a name, or whose properties are not an object', async () => {
  const { kirora, batches } = kiroraAnswering((batch) => accepted(batch));
  const untyped = kirora as unknown as {
    track(name: unknown, properties?: unknown): void;
  };
  untyped.track('');
  untyped.track(undefined);
  untyped.track('Plan Compared', null);
  untyped.track('Plan Compared', ['pro']);
  untyped.track('Plan Compared', new Date());
  untyped.track('Plan Compared', new Map([['plan', 'pro']]));
  kirora.track('Invoice Paid');

  await kirora.identify('token-for-ada');
  await kirora.flush();
  expect(batches.flatMap(names)).toEqual(['Invoice Paid']);
});

it('skips our own backoff for a flush() that joins a send already queued by a timer', async () => {
  let answerHeld: (() => void) | undefined;
  // Down for the first two sends, the second held until the test answers it.
  const { kirora, batches } = kiroraAnswering((batch) => {
    if (batches.length === 1) return new Response(null, { status: 503 });
    if (batches.length === 2) {
      return new Promise<Response>(
        (resolve) => (answerHeld = () => resolve(new Response(null, { status: 503 }))),
      );
    }
    return accepted(batch);
  });
  kirora.track('Plan Compared');
  await kirora.identify('token-for-ada');
  await vi.waitFor(() => expect(batches).toHaveLength(1));

  // Backing off now. A flush() goes anyway, and is held.
  void kirora.flush();
  await vi.waitFor(() => expect(answerHeld).toBeDefined());
  // A full queue asks for a send that waits out the backoff; then flush() joins it.
  for (let index = 0; index < 20; index++) kirora.track('Plan Upgraded');
  // Once they're queued, which is what asks for that send.
  await new Promise((resolve) => setTimeout(resolve));
  const flushed = kirora.flush();
  answerHeld!();
  await flushed;

  expect(batches).toHaveLength(3);
});

it('goes back to full batches once a split has found the event to blame', async () => {
  const { kirora, batches } = kiroraAnswering((batch) =>
    batch.events.some((event) => event.properties.note)
      ? refusingNote(batch)
      : accepted(batch),
  );
  kirora.track('Note Saved', { note: 'invalid' });
  for (let index = 0; index < 9; index++) kirora.track('Plan Compared');

  await kirora.identify('token-for-ada');
  await kirora.flush();
  // 10, 5, 3, 2 and 1 refused; then the other 9 together.
  expect(batches.map((batch) => batch.events.length)).toEqual([10, 5, 3, 2, 1, 9]);
});

it('sends a batch too large for Kirora in halves, dropping only the event to blame', async () => {
  const { kirora, batches } = kiroraAnswering((batch) =>
    batch.events.some((event) => event.properties.note)
      ? new Response(null, { status: 413 })
      : accepted(batch),
  );
  kirora.track('Plan Compared');
  kirora.track('Note Saved', { note: 'too long' });
  kirora.track('Plan Upgraded');
  kirora.track('Invoice Paid');

  await kirora.identify('token-for-ada');
  await kirora.flush();
  const delivered = batches.filter((batch) => !names(batch).includes('Note Saved'));
  expect(delivered.flatMap(names)).toEqual([
    'Plan Compared',
    'Plan Upgraded',
    'Invoice Paid',
  ]);
  // The event to blame was dropped, so nothing is left to send.
  const sentSoFar = batches.length;
  await kirora.flush();
  expect(batches).toHaveLength(sentSoFar);
});

it('keeps each batch under the size Kirora takes', async () => {
  const { kirora, batches } = kiroraAnswering((batch) => accepted(batch));
  const large = { text: 'x'.repeat(30_000) };
  for (let index = 0; index < 10; index++) kirora.track('Document Saved', large);

  await kirora.identify('token-for-ada');
  await kirora.flush();
  expect(batches.map((batch) => batch.events.length)).toEqual([6, 4]);
});

it('skips an event whose properties cannot be stored, and tracks the next one', async () => {
  const { kirora, batches } = kiroraAnswering((batch) => accepted(batch));
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  kirora.track('Broken', circular);
  kirora.track('Plan Upgraded');
  await kirora.identify('token-for-ada');
  await kirora.flush();
  expect(batches.flatMap(names)).toEqual(['Plan Upgraded']);
});

it("waits out Kirora's Retry-After, whatever else asks to send", async () => {
  vi.useFakeTimers();
  let throttled = true;
  const { kirora, batches } = kiroraAnswering((batch) =>
    throttled
      ? new Response(null, { status: 429, headers: { 'retry-after': '120' } })
      : accepted(batch),
  );
  kirora.track('Plan Upgraded');
  await kirora.identify('token-for-ada');
  await kirora.flush();
  expect(batches).toHaveLength(1);

  // More events, a manual flush, coming back online: none may send before 120 seconds.
  for (let index = 0; index < 25; index++) kirora.track(`Event ${index}`);
  await kirora.flush();
  await vi.advanceTimersByTimeAsync(119_000);
  expect(batches).toHaveLength(1);

  throttled = false;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(batches.length).toBeGreaterThan(1);
  vi.useRealTimers();
});

it('backs off from a token route whose tokens Kirora keeps refusing', async () => {
  vi.useFakeTimers();
  try {
    let requests = 0;
    let tokenFetches = 0;
    vi.stubGlobal('fetch', () => {
      requests++;
      return Promise.resolve(new Response(null, { status: 401 }));
    });
    const kirora = new Kirora({
      clientKey: 'kirora_pk_test',
      trackSessions: false,
      logLevel: 'none',
      fetchUserToken: () => Promise.resolve(tokenFor('ada', `-${++tokenFetches}`)),
    });
    await kirora.identify(tokenFor('ada'));

    // Tracking on for three minutes while every send is refused, refreshed once, and
    // refused again. Each event would otherwise ask for another try within 30 seconds;
    // backing off (30 seconds, then a minute, then two) leaves three tries.
    for (let tick = 0; tick < 18; tick++) {
      kirora.track('Plan Compared');
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect([requests, tokenFetches]).toEqual([6, 3]);
  } finally {
    vi.useRealTimers();
  }
});

it('understands Retry-After as an HTTP date', async () => {
  const { retryAfterMs } = await import('../src/utils/retry-after.js');
  const inTwoMinutes = new Date(Date.now() + 120_000).toUTCString();
  expect(retryAfterMs(inTwoMinutes)).toBeGreaterThan(115_000);
  expect(retryAfterMs('120')).toBe(120_000);
  expect(retryAfterMs('soon')).toBeUndefined();
  expect(retryAfterMs(new Date(0).toUTCString())).toBeUndefined();
});

it('keeps events Kirora answered for none of', async () => {
  let answer: 'nothing' | 'all' = 'nothing';
  const { kirora, batches } = kiroraAnswering((batch) =>
    answer === 'all' ? accepted(batch) : Response.json({ data: { results: [] } }),
  );
  kirora.track('Plan Upgraded');
  await kirora.identify('token-for-ada');
  await kirora.flush();
  const unanswered = batches.length;
  answer = 'all';
  await kirora.flush();
  // Kept until Kirora answered for it, then never sent again.
  expect(batches).toHaveLength(unanswered + 1);
  expect(batches.flatMap(names).every((name) => name === 'Plan Upgraded')).toBe(true);
  await kirora.flush();
  expect(batches).toHaveLength(unanswered + 1);
});

it('keeps events in memory when localStorage stops taking them', async () => {
  let full = false;
  stubLocalStorage(() => full);
  const { kirora, batches } = kiroraAnswering((batch) => accepted(batch));
  full = true;
  kirora.track('Plan Upgraded');
  await kirora.identify('token-for-ada');
  await kirora.flush();
  expect(batches.map(names)).toEqual([['Plan Upgraded']]);
});

/** A response whose headers arrive but whose body never finishes. */
function stalledResponse(status: number, onCancel: () => void = () => undefined) {
  return new Response(new ReadableStream({ cancel: onCancel }), { status });
}

it.each([200, 500])(
  'gives up on a %i answer whose body stops arriving, keeping the events',
  async (status) => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      let stalled = true;
      vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
        signals.push(init.signal!);
        return Promise.resolve(stalled ? stalledResponse(status) : accepted(init.body));
      });
      const kirora = new Kirora({
        clientKey: 'kirora_pk_test',
        trackSessions: false,
        logLevel: 'none',
      });
      kirora.track('Invoice Paid');
      // Starts sending, and the answer stalls.
      await kirora.identify('token-for-ada');
      await vi.waitFor(() => expect(signals).toHaveLength(1));

      await vi.advanceTimersByTimeAsync(30_000);
      expect(signals[0]!.aborted).toBe(true);

      // The send let go, and the event is still there to send.
      stalled = false;
      await kirora.flush();
      const sentSoFar = signals.length;
      expect(sentSoFar).toBeGreaterThan(1);
      // Accepted this time, so nothing is left to send.
      await kirora.flush();
      expect(signals).toHaveLength(sentSoFar);
    } finally {
      vi.useRealTimers();
    }
  },
);

it("lets go of a refused answer's body before trying again with a fresh token", async () => {
  let cancelled = false;
  const tokens: (string | null)[] = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    tokens.push(new Headers(init.headers).get('authorization'));
    return Promise.resolve(
      tokens.length === 1
        ? stalledResponse(401, () => (cancelled = true))
        : accepted(init.body),
    );
  });
  const kirora = new Kirora({
    clientKey: 'kirora_pk_test',
    trackSessions: false,
    fetchUserToken: () => Promise.resolve(tokenFor('ada', '-fresh')),
  });
  kirora.track('Invoice Paid');
  await kirora.identify(tokenFor('ada', '-expired'));
  await kirora.flush();
  expect(tokens).toEqual([
    `Bearer ${tokenFor('ada', '-expired')}`,
    `Bearer ${tokenFor('ada', '-fresh')}`,
  ]);
  expect(cancelled).toBe(true);
});

it.each([408, 425])('keeps a batch answered %i, to retry it', async (status) => {
  let answered = false;
  const { kirora, batches } = kiroraAnswering((batch) => {
    if (answered) return accepted(batch);
    answered = true;
    return new Response(null, { status });
  });
  kirora.track('Invoice Paid');
  await kirora.identify('token-for-ada');
  await kirora.flush();
  await kirora.flush();
  expect(batches.map(names)).toEqual([['Invoice Paid'], ['Invoice Paid']]);
});

it('sends an event once when the same user is identified again while it is on its way', async () => {
  let answerFirst: () => void = () => undefined;
  const { kirora, batches } = kiroraAnswering(async (batch) => {
    if (batches.length === 1)
      await new Promise<void>((resolve) => (answerFirst = resolve));
    return accepted(batch);
  });
  await kirora.identify(tokenFor('ada'));
  kirora.track('Pricing Viewed');
  const first = kirora.flush();
  await vi.waitFor(() => expect(batches).toHaveLength(1));

  // As React's StrictMode, or the next page load's identify(), does.
  await kirora.identify(tokenFor('ada', 'fresh'));
  kirora.track('Plan Compared');
  const second = kirora.flush();
  answerFirst();
  await Promise.all([first, second]);
  expect(batches.map(names)).toEqual([['Pricing Viewed'], ['Plan Compared']]);
  kirora.destroy();
});

it('sends nothing more after a refused token it cannot replace, until identify()', async () => {
  const tokens = kiroraRefusing((token) => token === 'expired-token');
  const kirora = new Kirora({
    clientKey: 'kirora_pk_test',
    trackSessions: false,
    logLevel: 'none',
  });
  kirora.track('Plan Upgraded');
  await kirora.identify('expired-token');
  await kirora.flush();
  expect(tokens).toEqual(['expired-token']);

  // Neither the timer, a full queue nor a flush asks Kirora again with the same token.
  for (let index = 0; index < 25; index++) kirora.track(`Event ${index}`);
  await kirora.flush();
  expect(tokens).toHaveLength(1);

  // Nor does any other call: it's refused at once.
  await expect(kirora.setPushConsent(true)).rejects.toMatchObject({ status: 401 });
  expect(tokens).toHaveLength(1);

  await kirora.identify('fresh-token');
  await kirora.flush();
  expect(tokens.at(-1)).toBe('fresh-token');
});

it('sends at once as the page is hidden, without waiting for a lock granted too late', async () => {
  const { kirora, batches } = kiroraAnswering((batch) => accepted(batch));
  await kirora.identify('token-for-ada');
  await kirora.flush();
  // As the page goes away, a lock is only granted on a later task: by then it's gone.
  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, callback: () => Promise<unknown>) =>
        new Promise((resolve) => setTimeout(() => resolve(callback()))),
    },
  });
  vi.stubGlobal('document', { visibilityState: 'hidden' });
  kirora.track('Checkout Left');
  void kirora.flush();
  // Microtasks only, as before the page is torn down.
  for (let index = 0; index < 20; index++) await Promise.resolve();
  expect(batches.flatMap(names)).toEqual(['Checkout Left']);
  kirora.destroy();
});

it("doesn't wait for a send on its way as the page is hidden, nor send its events twice", async () => {
  let answerFirst: () => void = () => undefined;
  const { kirora, batches } = kiroraAnswering((batch) =>
    batches.length === 1
      ? new Promise<Response>((resolve) => (answerFirst = () => resolve(accepted(batch))))
      : accepted(batch),
  );
  kirora.track('Plan Compared');
  await kirora.identify('token-for-ada');
  void kirora.flush();
  await vi.waitFor(() => expect(batches).toHaveLength(1));

  // The page hides while that send waits for its answer, which would come too late.
  vi.stubGlobal('document', { visibilityState: 'hidden' });
  kirora.track('Checkout Left');
  void kirora.flush();
  for (let index = 0; index < 20; index++) await Promise.resolve();
  expect(batches.map(names)).toEqual([['Plan Compared'], ['Checkout Left']]);

  answerFirst();
  await kirora.flush();
  expect(batches.map(names)).toEqual([['Plan Compared'], ['Checkout Left']]);
  kirora.destroy();
});
