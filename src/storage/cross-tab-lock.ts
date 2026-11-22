// A lock shared by every tab of the site, for browsers without Web Locks (before Firefox
// 96 and Safari 15.4). IndexedDB never runs two read-write transactions on the same
// store at once, in any tab, and a transaction stays open while its callbacks run, so
// synchronous work done in one of its callbacks can't interleave with another tab's.

const DATABASE = 'kirora-locks';
const STORE = 'locks';

/** IndexedDB is missing or refused (as in some private windows): nothing was run. */
export class LockUnavailable extends Error {}

/** A connection still unopened after this is given up on (Safari 14 can hang). */
const OPEN_TIMEOUT_MS = 3000;

/** One connection, opened on first use and kept. */
let connection: Promise<IDBDatabase> | undefined;
/** The IndexedDB `connection` was opened with. */
let openedWith: IDBFactory | undefined;
/** Set once opening hung: this page runs unlocked rather than waiting again. */
let stalled = false;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new LockUnavailable('no IndexedDB'));
  }
  if (stalled) {
    return Promise.reject(new LockUnavailable('IndexedDB never opened'));
  }
  // A connection belongs to the IndexedDB that opened it, which a page never replaces.
  if (openedWith !== indexedDB) {
    connection = undefined;
    openedWith = indexedDB;
  }
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    // Throws where IndexedDB is missing or refused, before any timer is set.
    const open = indexedDB.open(DATABASE, 1);
    const timeout = setTimeout(() => {
      stalled = true;
      reject(new LockUnavailable('IndexedDB never opened'));
    }, OPEN_TIMEOUT_MS);

    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => {
      clearTimeout(timeout);
      const database = open.result;

      // Opened after all, only late: the lock works again from now on.
      if (stalled) {
        stalled = false;
        connection = Promise.resolve(database);
      }

      // A later version of the SDK wants to change the database: let it, and reconnect.
      database.onversionchange = () => {
        database.close();
        connection = undefined;
      };
      resolve(database);
    };
    open.onerror = () => {
      clearTimeout(timeout);
      reject(new LockUnavailable(String(open.error)));
    };
  }).catch((error: unknown) => {
    connection = undefined;
    throw error instanceof LockUnavailable ? error : new LockUnavailable(String(error));
  });
  return connection;
}

/**
 * `localStorage` can lag behind another tab's write, even one made under the same lock:
 * in Chromium the write reaches other tabs' copies after the lock does, so a tab can read
 * a stale queue and write over another's events. IndexedDB is the same in every tab once
 * a transaction completes, so a revision kept there says which write a tab's
 * `localStorage` must show before it's read. Kept in the lock's store, under `name`.
 */
export async function readRevision(name: string): Promise<number> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).get(name);
    request.onsuccess = () => resolve(revisionOf(request.result));
    request.onerror = () => reject(new LockUnavailable(String(request.error)));
  });
}

/** Forgets the revision under `name`, as its queue is cleared for good. */
export async function forgetRevision(name: string): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).delete(name);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(new LockUnavailable(String(transaction.error)));
  });
}

/**
 * Records `revision` under `name`, unless a later one is there, resolving once every tab
 * can read it.
 */
export async function writeRevision(name: string, revision: number): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const current = store.get(name);
    current.onsuccess = () => {
      const stored = revisionOf(current.result);
      if (stored < revision) {
        store.put(revision, name);
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(new LockUnavailable(String(transaction.error)));
  });
}

/**
 * Runs the synchronous `operation` while no other tab can run one, and resolves with its
 * result, or rejects with what it threw. Rejects with `LockUnavailable`, having run
 * nothing, if IndexedDB can't be used.
 *
 * `operation` is given the revision stored under `name` (see `readRevision`). It answers
 * its result, with the revision it leaves if it wrote, which is saved with the lock. Or,
 * where this tab's `localStorage` hasn't caught up yet, it does nothing and answers
 * undefined, and the lock resolves undefined: the caller asks again shortly.
 */
export async function withCrossTabLock<Done extends { revision?: number }>(
  name: string,
  operation: (revision: number) => Done | undefined,
): Promise<Done | undefined> {
  const database = await openDatabase();
  return new Promise<Done | undefined>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE, 'readwrite');
    } catch (error) {
      // The connection was closed under us.
      connection = undefined;
      reject(new LockUnavailable(String(error)));
      return;
    }

    let outcome: { done: Done | undefined } | { error: unknown } | undefined;

    // Its callback runs while the transaction holds the lock.
    const store = transaction.objectStore(STORE);
    const request = store.get(name);
    request.onsuccess = () => {
      try {
        const done = operation(revisionOf(request.result));
        if (done && done.revision !== undefined) {
          store.put(done.revision, name);
        }
        outcome = { done };
      } catch (error) {
        outcome = { error };
      }
    };

    const settle = () => {
      if (!outcome) {
        reject(new LockUnavailable('the lock transaction ended unused'));
      } else if ('error' in outcome) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rethrown as thrown
        reject(outcome.error);
      } else {
        resolve(outcome.done);
      }
    };
    transaction.oncomplete = settle;
    transaction.onabort = settle;
  });
}

/** A stored revision as a number: 0 where there's none yet. */
function revisionOf(stored: unknown): number {
  return Number(stored) || 0;
}
