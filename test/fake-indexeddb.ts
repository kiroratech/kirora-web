import { vi } from 'vitest';

type Request = { result: unknown; onsuccess?: () => void };

/**
 * Stubs `indexedDB` with just what the SDK uses: databases whose object stores are maps,
 * requests that succeed in a microtask, and transactions that complete once their
 * requests have. Read-write transactions run one at a time, in the order they were made,
 * as IndexedDB runs them across tabs. Returns every database's stores, by store name.
 */
export function stubIndexedDB(): Map<string, Map<string, unknown>> {
  const stores = new Map<string, Map<string, unknown>>();
  const databases = new Set<string>();
  const later = (callback: () => void) => queueMicrotask(callback);
  /** When the read-write transaction made last has finished. */
  let lastReadWrite: Promise<void> = Promise.resolve();
  const database = {
    createObjectStore: (name: string) => stores.set(name, new Map()),
    close: () => undefined,
    transaction: (name: string, mode = 'readonly') => {
      const transaction: { oncomplete?: () => void; onabort?: () => void } = {};
      const store = stores.get(name)!;
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => (finish = resolve));
      // A read-write transaction waits for the one made before it.
      const ready = mode === 'readwrite' ? lastReadWrite : Promise.resolve();
      if (mode === 'readwrite') {
        lastReadWrite = finished;
      }
      const request = (run: () => unknown): Request => {
        const pending: Request = { result: undefined };
        void ready.then(() => {
          pending.result = run();
          pending.onsuccess?.();
          later(() => {
            transaction.oncomplete?.();
            finish();
          });
        });
        return pending;
      };
      return Object.assign(transaction, {
        objectStore: () => ({
          get: (key: string) => request(() => store.get(key)),
          put: (value: unknown, key: string) => request(() => store.set(key, value)),
          delete: (key: string) => request(() => store.delete(key)),
        }),
      });
    },
  };
  vi.stubGlobal('indexedDB', {
    open: (name: string) => {
      const open: {
        result: typeof database;
        onupgradeneeded?: () => void;
        onsuccess?: () => void;
      } = { result: database };
      later(() => {
        if (!databases.has(name)) {
          databases.add(name);
          open.onupgradeneeded?.();
        }
        open.onsuccess?.();
      });
      return open;
    },
  });
  return stores;
}
