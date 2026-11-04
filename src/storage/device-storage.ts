import { STORAGE_KEYS } from './keys.js';

/** The bits of `Storage` we use: `localStorage`, memory, or cookies across the site. */
export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * `localStorage`, falling back to memory if it's unavailable (e.g. blocked site data) or
 * stops accepting writes (e.g. a full quota). After a failed write, writes go to memory for
 * the rest of the page's life, so reads stay consistent with what was written;
 * `onFallback` is told once. Never throws, so it never breaks the page.
 */
export function deviceStorage(onFallback: (error: unknown) => void): KeyValueStorage {
  /** Values written since falling back. `null` shadows a removed localStorage value. */
  const memory = new Map<string, string | null>();
  let storage: Storage | undefined;
  try {
    storage = globalThis.localStorage;
    storage.setItem(STORAGE_KEYS.probe, '1');
    storage.removeItem(STORAGE_KEYS.probe);
  } catch {
    storage = undefined;
  }
  let persistent = storage !== undefined;
  const fallBack = (error: unknown) => {
    if (!persistent) return;
    persistent = false;
    onFallback(error);
  };
  return {
    getItem: (key) => {
      if (memory.has(key)) return memory.get(key) ?? null;
      try {
        return storage?.getItem(key) ?? null;
      } catch (error) {
        fallBack(error);
        return null;
      }
    },
    setItem: (key, value) => {
      if (persistent) {
        try {
          storage?.setItem(key, value);
          return;
        } catch (error) {
          fallBack(error);
        }
      }
      memory.set(key, value);
    },
    removeItem: (key) => {
      // Memory is only used once we've fallen back.
      if (!persistent) memory.set(key, null);
      try {
        storage?.removeItem(key);
      } catch (error) {
        fallBack(error);
      }
    },
  };
}

/** Parsed JSON, or `null` if missing or invalid. */
export function readJson(storage: KeyValueStorage, key: string): unknown {
  try {
    return JSON.parse(storage.getItem(key) ?? 'null') as unknown;
  } catch {
    return null;
  }
}
