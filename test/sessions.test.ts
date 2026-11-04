import { afterEach, expect, it, vi } from 'vitest';
import { Kirora } from '../src/index.js';
import { recordEvents } from './fake-kirora.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('begins a visit with Session Started and a new one after 30 quiet minutes', async () => {
  const sent = recordEvents();
  vi.useFakeTimers({ toFake: ['Date'] });
  const kirora = new Kirora({ clientKey: 'kirora_pk_test' });

  kirora.track('Pricing Viewed');
  kirora.track('Plan Compared');
  vi.setSystemTime(Date.now() + 29 * 60_000);
  kirora.track('Signup Started');
  vi.setSystemTime(Date.now() + 31 * 60_000);
  kirora.track('Pricing Viewed');

  await kirora.identify('token-for-ada');
  await kirora.flush();
  expect(sent.map((event) => event.name)).toEqual([
    'Session Started',
    'Pricing Viewed',
    'Plan Compared',
    'Signup Started',
    'Session Started',
    'Pricing Viewed',
  ]);
  const [first, second] = [sent[0]!.context.sessionId, sent[4]!.context.sessionId];
  expect(sent.slice(0, 4).every((event) => event.context.sessionId === first)).toBe(true);
  expect(second).not.toBe(first);
  // One browser throughout, whatever the visit.
  const devices = new Set(sent.map((event) => event.context.device?.id));
  expect(devices.size).toBe(1);
  expect([...devices][0]).toEqual(expect.any(String));
});

it('keeps a visit going while the page is visible, and starts one on return', async () => {
  const sent = recordEvents();
  const listeners: (() => void)[] = [];
  const page = {
    visibilityState: 'visible',
    title: 'Docs',
    referrer: '',
    // No cookies, so the session lives in device storage.
    cookie: '',
    querySelector: () => null,
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'visibilitychange') listeners.push(listener);
    },
  };
  const setVisibility = (state: 'visible' | 'hidden') => {
    page.visibilityState = state;
    for (const listener of listeners) listener();
  };
  vi.stubGlobal('document', page);
  vi.stubGlobal('location', new URL('https://example.com/docs'));
  vi.stubGlobal('addEventListener', () => undefined);
  vi.useFakeTimers();
  const kirora = new Kirora({ clientKey: 'kirora_pk_test' });

  // Reading for 40 minutes without tracking anything.
  vi.advanceTimersByTime(40 * 60_000);
  kirora.track('Docs Read');
  // Away for 31 minutes, then back.
  setVisibility('hidden');
  vi.advanceTimersByTime(31 * 60_000);
  setVisibility('visible');
  // The computer sleeps with the page open: waking up isn't activity.
  vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
  vi.advanceTimersByTime(5 * 60_000);

  await kirora.identify('token-for-ada');
  await kirora.flush();
  expect(sent.map((event) => event.name)).toEqual([
    'Session Started',
    'Docs Read',
    'Session Started',
  ]);
  const [first, read, second] = sent.map((event) => event.context.sessionId);
  expect(read).toBe(first);
  expect(second).not.toBe(first);
});

it('sends each event with the fields the client API takes', async () => {
  const sent = recordEvents();
  const kirora = new Kirora({ clientKey: 'kirora_pk_test', trackSessions: false });
  kirora.track('Plan Upgraded', { plan: 'pro' });
  await kirora.identify('token-for-ada');
  await kirora.flush();
  expect(Object.keys(sent[0]!).sort()).toEqual([
    'context',
    'idempotencyKey',
    'name',
    'occurredAt',
    'properties',
  ]);
  expect(sent[0]).toMatchObject({ name: 'Plan Upgraded', properties: { plan: 'pro' } });
});
