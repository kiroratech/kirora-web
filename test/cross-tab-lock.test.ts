import { afterEach, expect, it, vi } from 'vitest';
import type { QueuedEvent } from '../src/events/event-queue.js';
import { memoryStorage } from './fake-kirora.js';
import { stubIndexedDB } from './fake-indexeddb.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The queue, loaded afresh: the lock keeps its IndexedDB connection for the page's life,
 * so each test needs its own page.
 */
async function loadQueue() {
  vi.resetModules();
  return (await import('../src/events/event-queue.js')).EventQueue;
}

const event = (name: string): QueuedEvent => ({
  idempotencyKey: name,
  name,
  properties: {},
  occurredAt: new Date(0).toISOString(),
  context: {},
});

/** A browser without Web Locks, as before Firefox 96 and Safari 15.4. */
function withoutWebLocks() {
  vi.stubGlobal('navigator', {});
}

it('reads and writes the queue inside an IndexedDB read-write transaction', async () => {
  withoutWebLocks();
  stubIndexedDB();
  const storage = memoryStorage();
  const transactions: string[] = [];
  let inTransaction = false;
  const { indexedDB: fake } = globalThis as unknown as { indexedDB: IDBFactory };
  vi.stubGlobal('indexedDB', {
    open: (name: string) => {
      const open = fake.open(name);
      const database = open.result as unknown as {
        transaction: (store: string, mode?: string) => IDBTransaction;
      };
      const transaction = database.transaction.bind(database);
      database.transaction = (store, mode) => {
        transactions.push(`${name}/${store}/${mode ?? 'readonly'}`);
        const made = transaction(store, mode);
        const objectStore = made.objectStore.bind(made);
        made.objectStore = (storeName: string) => {
          const opened = objectStore(storeName);
          const get = opened.get.bind(opened);
          opened.get = (key: IDBValidKey) => {
            const request = get(key);
            let onsuccess: (() => void) | null = null;
            Object.defineProperty(request, 'onsuccess', {
              get: () => onsuccess,
              set: (callback: () => void) => {
                onsuccess = () => {
                  inTransaction = true;
                  try {
                    callback();
                  } finally {
                    inTransaction = false;
                  }
                };
              },
            });
            return request;
          };
          return opened;
        };
        return made;
      };
      return open;
    },
  });
  const writes: boolean[] = [];
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    writes.push(inTransaction);
    setItem(key, value);
  };

  const queue = new (await loadQueue())(storage, 'workspace');
  await queue.add(event('Pricing Viewed'), null);
  expect(await queue.adopt('ada', () => true)).toEqual(new Set(['Pricing Viewed']));
  expect(transactions.every((made) => made === 'kirora-locks/locks/readwrite')).toBe(
    true,
  );
  expect(transactions.length).toBeGreaterThan(0);
  // The queue and the revision beside it, each time.
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.every(Boolean)).toBe(true);
});

it('lets only the first of two tabs adopt an event, in the order they asked', async () => {
  withoutWebLocks();
  stubIndexedDB();
  const storage = memoryStorage();
  const EventQueue = await loadQueue();
  await new EventQueue(storage, 'workspace').add(event('Pricing Viewed'), null);
  const adaTab = new EventQueue(storage, 'workspace');
  const bobTab = new EventQueue(storage, 'workspace');
  const [ada, bob] = await Promise.all([
    adaTab.adopt('ada', () => true),
    bobTab.adopt('bob', () => true),
  ]);
  expect(ada).toEqual(new Set(['Pricing Viewed']));
  expect(bob).toEqual(new Set());
  expect((await bobTab.oldest(10, 'bob')).length).toBe(0);
  expect((await adaTab.oldest(10, 'ada')).map((queued) => queued.name)).toEqual([
    'Pricing Viewed',
  ]);
});

it('still works, unlocked, where IndexedDB is refused', async () => {
  withoutWebLocks();
  let opened = 0;
  vi.stubGlobal('indexedDB', {
    open: () => {
      opened++;
      const open: { error: Error; onerror?: () => void } = {
        error: new Error('refused'),
      };
      queueMicrotask(() => open.onerror?.());
      return open;
    },
  });
  const queue = new (await loadQueue())(memoryStorage(), 'workspace');
  await queue.add(event('Pricing Viewed'), null);
  expect(await queue.adopt('ada', () => true)).toEqual(new Set(['Pricing Viewed']));
  expect(opened).toBeGreaterThan(0);
});

it('runs an operation that fails once, passing on what it threw', async () => {
  withoutWebLocks();
  stubIndexedDB();
  const storage = memoryStorage();
  let reads = 0;
  storage.getItem = () => {
    reads++;
    throw new Error('broken');
  };
  const queue = new (await loadQueue())(storage, 'workspace');
  await expect(queue.oldest(10, 'ada')).rejects.toThrow('broken');
  expect(reads).toBe(1);
});
