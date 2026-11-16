// A lock shared by every tab of the site, for browsers without Web Locks (before Firefox
// 96 and Safari 15.4). IndexedDB never runs two read-write transactions on the same
// store at once, in any tab, and a transaction stays open while its callbacks run, so
// synchronous work done in one of its callbacks can't interleave with another tab's.

const DATABASE = 'kirora-locks';
const STORE = 'locks';

/** IndexedDB is missing or refused (as in some private windows): nothing was run. */
export class LockUnavailable extends Error {}

/** One connection, opened on first use and kept. */
let connection: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DATABASE, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => {
      const database = open.result;
      // A later version of the SDK wants to change the database: let it, and reconnect.
      database.onversionchange = () => {
        database.close();
        connection = undefined;
      };
      resolve(database);
    };
    open.onerror = () => reject(new LockUnavailable(String(open.error)));
  }).catch((error: unknown) => {
    connection = undefined;
    throw error instanceof LockUnavailable ? error : new LockUnavailable(String(error));
  });
  return connection;
}

/**
 * Runs the synchronous `operation` while no other tab can run one, and resolves with its
 * result, or rejects with what it threw. Rejects with `LockUnavailable`, having run
 * nothing, if IndexedDB can't be used.
 */
export async function withCrossTabLock<Result>(operation: () => Result): Promise<Result> {
  const database = await openDatabase();
  return new Promise<Result>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE, 'readwrite');
    } catch (error) {
      // The connection was closed under us.
      connection = undefined;
      reject(new LockUnavailable(String(error)));
      return;
    }
    let outcome: { result: Result } | { error: unknown } | undefined;
    // Any request will do: its callback runs while the transaction holds the lock.
    transaction.objectStore(STORE).get(STORE).onsuccess = () => {
      try {
        outcome = { result: operation() };
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
