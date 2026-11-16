import { vi } from 'vitest';

/**
 * Stubs `indexedDB` with just what the push subscription store uses: one database whose
 * object stores are maps, and transactions that complete in a microtask. Returns the
 * stores, by name.
 */
export function stubIndexedDB(): Map<string, Map<string, unknown>> {
  const stores = new Map<string, Map<string, unknown>>();
  const later = (callback: () => void) => queueMicrotask(callback);
  const database = {
    createObjectStore: (name: string) => stores.set(name, new Map()),
    close: () => undefined,
    transaction: (name: string) => {
      const transaction: { oncomplete?: () => void } = {};
      const store = stores.get(name)!;
      const request = (result: unknown) => {
        later(() => transaction.oncomplete?.());
        return { result };
      };
      return Object.assign(transaction, {
        objectStore: () => ({
          get: (key: string) => request(store.get(key)),
          put: (value: unknown, key: string) => request(store.set(key, value)),
          delete: (key: string) => request(store.delete(key)),
        }),
      });
    },
  };
  vi.stubGlobal('indexedDB', {
    open: () => {
      const open: {
        result: typeof database;
        onupgradeneeded?: () => void;
        onsuccess?: () => void;
      } = { result: database };
      later(() => {
        if (stores.size === 0) open.onupgradeneeded?.();
        open.onsuccess?.();
      });
      return open;
    },
  });
  return stores;
}
