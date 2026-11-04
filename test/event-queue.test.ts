import { expect, it, vi } from 'vitest';
import { EventQueue, type QueuedEvent } from '../src/events/event-queue.js';
import { memoryStorage } from './fake-kirora.js';

const event = (name: string): QueuedEvent => ({
  idempotencyKey: name,
  name,
  properties: {},
  occurredAt: new Date(0).toISOString(),
  context: { device: { id: 'browser-1' } },
});

const names = async (queue: EventQueue) =>
  (await queue.oldest(100, null)).map((queued) => queued.name);

it('saves the events added in one tick with one write', async () => {
  const storage = memoryStorage();
  const writes = vi.spyOn(storage, 'setItem');
  const queue = new EventQueue(storage, 'workspace');

  const counts = await Promise.all([
    queue.add(event('Session Started'), null),
    queue.add(event('Page Viewed'), null),
    queue.add(event('Signup Started'), null),
  ]);
  expect(writes).toHaveBeenCalledTimes(1);
  expect(counts).toEqual([3, 3, 3]);
  expect(await names(queue)).toEqual([
    'Session Started',
    'Page Viewed',
    'Signup Started',
  ]);
});

it('keeps the order things were asked for around a batch', async () => {
  const queue = new EventQueue(memoryStorage(), 'workspace');
  void queue.add(event('Invoice Paid'), null);
  void queue.clearAll();
  await queue.add(event('Plan Upgraded'), null);
  // Cleared after the first add, and before the second.
  expect(await names(queue)).toEqual(['Plan Upgraded']);
});

it("notices another tab's changes, though it skips parsing unchanged ones", async () => {
  const storage = memoryStorage();
  const queue = new EventQueue(storage, 'workspace');
  const otherTab = new EventQueue(storage, 'workspace');
  await queue.add(event('Invoice Paid'), null);
  await otherTab.add(event('Plan Upgraded'), null);
  expect(await names(queue)).toEqual(['Invoice Paid', 'Plan Upgraded']);
});

it('stores exactly the JSON of what it keeps, past its limits too', async () => {
  const storage = memoryStorage();
  const queue = new EventQueue(storage, 'workspace');
  const large = { ...event('Document Saved'), properties: { text: 'x'.repeat(2_000) } };
  for (let index = 0; index < 1_200; index++) {
    await queue.add(
      { ...large, idempotencyKey: `event-${index}` },
      index % 2 ? 'ada' : null,
    );
  }
  const stored = storage.getItem('kirora:events:workspace')!;
  const kept = JSON.parse(stored) as { event: QueuedEvent }[];
  // Under 1 MB and 1,000 events, the newest kept, and the string what encoding gives.
  expect(stored.length).toBeLessThanOrEqual(1_000_000);
  expect(kept.length).toBeLessThan(1_000);
  expect(kept.at(-1)!.event.idempotencyKey).toBe('event-1199');
  expect(JSON.stringify(kept)).toBe(stored);
});

it('rebuilds the JSON when the stored queue had unreadable entries', async () => {
  const storage = memoryStorage();
  storage.setItem(
    'kirora:events:workspace',
    JSON.stringify([{ owner: null, event: event('Invoice Paid') }, { broken: true }]),
  );
  const queue = new EventQueue(storage, 'workspace');
  await queue.add(event('Plan Upgraded'), null);
  const stored = storage.getItem('kirora:events:workspace')!;
  expect(JSON.parse(stored)).toHaveLength(2);
  expect(await names(queue)).toEqual(['Invoice Paid', 'Plan Upgraded']);
});
