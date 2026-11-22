// A lock shared by every tab of the site, for browsers without Web Locks (before Firefox
// 96 and Safari 15.4). IndexedDB never runs two read-write transactions on the same
// store at once, in any tab, and a transaction stays open while its callbacks run, so
// synchronous work done in one of its callbacks can't interleave with another tab's.

const DATABASE = 'kirora-locks';
const STORE = 'locks';

/** IndexedDB is missing or refused (as in some private windows): nothing was run. */
export class LockUnavailable extends Error {}

/** `localStorage` hasn't caught up with another tab's write yet: try again shortly. */
export const NOT_YET = Symbol('not yet');

/** What a locked operation did, and the revision it leaves, if it wrote. */
export type Locked<Result> = { result: Result; revision?: number } | typeof NOT_YET;

/** A connection still unopened after this is given up on (Safari 14 can hang). */
const OPEN_TIMEOUT_MS = 3000;

/** One connection, opened on first use and kept. */
let connection: Promise<IDBDatabase> | undefined;
/** Set once opening hung: this page runs unlocked rather than waiting again. */
let stalled = false;

function openDatabase(): Promise<IDBDatabase> {
  if (stalled) return Promise.reject(new LockUnavailable('IndexedDB never opened'));
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
    request.onsuccess = () => resolve(Number(request.result) || 0);
    request.onerror = () => reject(new LockUnavailable(String(request.error)));
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
      if (!(Number(current.result) >= revision)) store.put(revision, name);
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(new LockUnavailable(String(transaction.error)));
  });
}

/**
 * Runs the synchronous `operation` while no other tab can run one, and resolves with its
 * result, or rejects with what it threw. Rejects with `LockUnavailable`, having run
 * nothing, if IndexedDB can't be used. `operation` is given the revision under
 * `revisionName`, and may answer a new one, saved with the lock: or answer `NOT_YET`, for
 * a `localStorage` that hasn't caught up, and the lock resolves `NOT_YET` unchanged.
 */
export async function withCrossTabLock<Result>(
  operation: (revision: number) => Locked<Result>,
  revisionName = STORE,
): Promise<Result | typeof NOT_YET> {
  const database = await openDatabase();
  return new Promise<Result | typeof NOT_YET>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE, 'readwrite');
    } catch (error) {
      // The connection was closed under us.
      connection = undefined;
      reject(new LockUnavailable(String(error)));
      return;
    }
    let outcome: { result: Result | typeof NOT_YET } | { error: unknown } | undefined;
    // Its callback runs while the transaction holds the lock.
    const store = transaction.objectStore(STORE);
    const request = store.get(revisionName);
    request.onsuccess = () => {
      try {
        const done = operation(Number(request.result) || 0);
        if (done === NOT_YET) {
          outcome = { result: NOT_YET };
          return;
        }
        if (done.revision !== undefined) store.put(done.revision, revisionName);
        outcome = { result: done.result };
      } catch (error) {
        outcome = { error };
      }
    };
    const settle = () => {
      if (!outcome) reject(new LockUnavailable('the lock transaction ended unused'));
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rethrown as thrown
      else if ('error' in outcome) reject(outcome.error);
      else resolve(outcome.result);
    };
    transaction.oncomplete = settle;
    transaction.onabort = settle;
  });
}
