import { readJson, type KeyValueStorage } from '../storage/device-storage.js';
import { uuid } from '../utils/uuid.js';

/** Its properties say how the visitor arrived. */
export const SESSION_STARTED_EVENT = 'Session Started';

/** The usual 30-minute inactivity timeout. */
const SESSION_TIMEOUT_MS = 30 * 60_000;
/** How often a visible page keeps its session alive: well inside the timeout. */
export const SESSION_KEEPALIVE_MS = 5 * 60_000;

/**
 * `owner` is the user whose visit it is: the token subject of whoever was signed in when
 * it was active, or null before anyone was.
 */
type StoredSession = { sessionId: string; lastActivityAt: number; owner?: string | null };

/** The session, in shared storage under `key`, which names the workspace. */
export type SessionStore = { storage: KeyValueStorage; key: string };

export function endSession({ storage, key }: SessionStore): void {
  storage.removeItem(key);
}

/**
 * Records `owner`'s activity on the current session. `started` is true if a new one
 * began: none was live, or it was another user's. Activity with no one signed in (a page
 * loading before `identify()`) continues whichever session is live, and a session begun
 * before sign-in becomes the user's who signs in.
 */
export function touchSession(
  store: SessionStore,
  owner: string | null,
): { sessionId: string; started: boolean } {
  const current = liveSession(store);
  const continues =
    current !== null &&
    (owner === null || (current.owner ?? null) === null || current.owner === owner);
  const sessionId = continues ? current.sessionId : uuid();
  save(store, sessionId, owner ?? current?.owner ?? null);
  return { sessionId, started: !continues };
}

/**
 * Extends the current session without starting a new one, so time on a visible page
 * never ends a visit but a timer alone never begins one.
 */
export function keepSessionAlive(store: SessionStore): void {
  const current = liveSession(store);
  if (current) save(store, current.sessionId, current.owner ?? null);
}

/** Records activity on `sessionId` now. */
function save(
  { storage, key }: SessionStore,
  sessionId: string,
  owner: string | null,
): void {
  const session: StoredSession = { sessionId, lastActivityAt: Date.now(), owner };
  storage.setItem(key, JSON.stringify(session));
}

/** The session, unless there's none or it timed out. */
function liveSession({ storage, key }: SessionStore): StoredSession | null {
  const stored = readJson(storage, key) as StoredSession | null;
  return stored &&
    typeof stored.sessionId === 'string' &&
    Date.now() - stored.lastActivityAt < SESSION_TIMEOUT_MS
    ? stored
    : null;
}
