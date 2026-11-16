// The subscription the page last registered, kept in IndexedDB for the service worker,
// which can't read localStorage: when the browser replaces the subscription, the worker
// tells Kirora with this, which the event itself may not carry.

/** What the worker needs to tell Kirora about a new subscription, without the page. */
export type SavedSubscription = {
  /** `POST /client/v1/push-subscription-change` on the page's Kirora. */
  url: string;
  clientKey: string;
  /** The `Kirora-SDK` header. */
  sdk: string;
  pushAppId: string;
  /** The key the subscription was made with, base64url, to subscribe again. */
  vapidPublicKey: string;
  subscription: PushSubscriptionJSON;
};

const DATABASE = 'kirora-push';
const STORE = 'subscriptions';

/**
 * Reads (`value` missing), saves or, with `null`, deletes the subscription saved for the
 * worker at `scope`, one per worker as a worker has one subscription. Rejects where
 * IndexedDB is missing or refused, as in some private windows.
 */
export function savedSubscription(
  scope: string,
  value?: SavedSubscription | null,
): Promise<SavedSubscription | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error!);
    open.onsuccess = () => {
      const database = open.result;
      try {
        const transaction = database.transaction(
          STORE,
          value === undefined ? 'readonly' : 'readwrite',
        );
        const store = transaction.objectStore(STORE);
        const request =
          value === undefined
            ? store.get(scope)
            : value
              ? store.put(value, scope)
              : store.delete(scope);
        // Settled once written, not just asked for.
        transaction.oncomplete = () => {
          database.close();
          resolve(
            value === undefined
              ? (request.result as SavedSubscription | undefined)
              : undefined,
          );
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
