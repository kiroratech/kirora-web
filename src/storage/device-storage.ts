import { STORAGE_KEYS } from './keys.js';

/** The bits of `Storage` we use: `localStorage`, memory, or cookies across the site. */
export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** `localStorage` as the SDK uses it, saying whether it can still be trusted. */
export type DeviceStorage = KeyValueStorage & {
  /** False once a write failed: what's written now is lost on reload. */
  readonly persistent: boolean;
  /** False if `localStorage` can't be read, so a missing value may just be unreadable. */
  readonly readable: boolean;
};

/**
 * `localStorage`, falling back to memory if it's unavailable (e.g. blocked site data) or
 * stops accepting writes (e.g. a full quota). After a failed write, writes go to memory for
 * the rest of the page's life, so reads stay consistent with what was written;
 * `onFallback` is told once. Never throws, so it never breaks the page.
 */
export function deviceStorage(onFallback: (error: unknown) => void): DeviceStorage {
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
  let readable = storage !== undefined;
  const fallBack = (error: unknown) => {
    if (!persistent) return;
    persistent = false;
    onFallback(error);
  };
  return {
    get persistent() {
      return persistent;
    },
    get readable() {
      return readable;
    },
    getItem: (key) => {
      if (memory.has(key)) return memory.get(key) ?? null;
      try {
        return storage?.getItem(key) ?? null;
      } catch (error) {
        readable = false;
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
      try {
        storage?.removeItem(key);
      } catch (error) {
        fallBack(error);
      }
      // Memory is only used once we've fallen back. Hides a value still stored, or one
      // that couldn't be removed, so reads match what was asked.
      if (!persistent) memory.set(key, null);
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
