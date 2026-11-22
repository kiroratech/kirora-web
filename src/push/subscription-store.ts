// The subscription the page last registered, kept in IndexedDB for the service worker,
// which can't read localStorage: when the browser replaces the subscription, the worker
// tells Kirora with this, which the event itself may not carry.

/** What the worker needs to tell Kirora about a new subscription, without the page. */
export type SavedSubscription = {
  /** `POST /client/v1/push-subscription-change` on the page's Kirora. */
  url: string;
  /** The page's `apiUrl`, without a trailing slash: push reports go only under it. */
  apiUrl: string;
  clientKey: string;
  /** The `Kirora-SDK` header. */
  sdk: string;
  pushAppId: string;
  /** The key the subscription was made with, base64url, to subscribe again. */
  vapidPublicKey: string;
  /**
   * The subscription registered. Missing once Kirora no longer has it (a 404 or 409 to
   * a subscription change): the rest stays, as tracking URLs are checked against `apiUrl`.
   */
  subscription?: PushSubscriptionJSON;
};

const DATABASE = 'kirora-push';
const STORE = 'subscriptions';

/** The subscription saved for the worker at `scope`, if any. */
export function readSubscription(scope: string): Promise<SavedSubscription | undefined> {
  return withStore('readonly', (store) => store.get(scope)) as Promise<
    SavedSubscription | undefined
  >;
}

/** Saves the subscription for the worker at `scope`: one per worker, as it has one. */
export async function saveSubscription(
  scope: string,
  value: SavedSubscription,
): Promise<void> {
  await withStore('readwrite', (store) => store.put(value, scope));
}

/** Forgets the subscription saved for the worker at `scope`. */
export async function forgetSubscription(scope: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(scope));
}

/**
 * Runs `request` on the store and resolves with its result once the transaction has
 * completed (written, not just asked for). Rejects where IndexedDB is missing or
 * refused, as in some private windows.
 */
function withStore(
  mode: IDBTransactionMode,
  request: (store: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error!);
    open.onsuccess = () => {
      const database = open.result;
      try {
        const transaction = database.transaction(STORE, mode);
        const asked = request(transaction.objectStore(STORE));
        transaction.oncomplete = () => {
          database.close();
          resolve(asked.result);
        };
        transaction.onerror = transaction.onabort = () => {
          database.close();
          reject(transaction.error!);
        };
      } catch (error) {
        database.close();
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rethrown as caught
        reject(error);
      }
    };
  });
}
