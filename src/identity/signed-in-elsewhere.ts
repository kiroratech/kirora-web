import { sessionOwner } from '../tracking/session.js';

// Which users other tabs of the site have signed in, told by a shared Web Lock each tab
// holds for its user: a lock is let go when its tab signs out or closes, so one still
// held means that user is signed in somewhere.

/** The lock named for `subject` in `namespace`: hashed, as the subject is a user's id. */
function lockName(namespace: string, subject: string): string {
  return `kirora:signed-in:${namespace}:${sessionOwner(subject)}`;
}

/**
 * Holds the lock for `subject` while this tab has them signed in. Returns a function
 * that lets it go. Does nothing where there are no Web Locks, or they're refused.
 */
export function holdSignedIn(namespace: string, subject: string): () => void {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) {
    return () => {};
  }

  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks
    .request(lockName(namespace, subject), { mode: 'shared' }, () => held)
    .catch(() => undefined);
  return release;
}

/**
 * Whether another tab has `subject` signed in: true or false, or undefined where it
 * can't be told (no Web Locks, before Firefox 96 and Safari 15.4, or refused).
 */
export async function signedInElsewhere(
  namespace: string,
  subject: string,
): Promise<boolean | undefined> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) {
    return undefined;
  }

  try {
    const { held = [] } = await locks.query();
    const name = lockName(namespace, subject);
    return held.some((lock) => lock.name === name);
  } catch {
    return undefined;
  }
}
