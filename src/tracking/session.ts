import { readJson, type KeyValueStorage } from '../storage/device-storage.js';
import { uuid } from '../utils/uuid.js';

/** Its properties say how the visitor arrived. */
export const SESSION_STARTED_EVENT = 'Session Started';

/** The usual 30-minute inactivity timeout. */
const SESSION_TIMEOUT_MS = 30 * 60_000;
/** How often a visible page keeps its session alive: well inside the timeout. */
export const SESSION_KEEPALIVE_MS = 5 * 60_000;

/** At most this many live sessions are kept: one per user active in this browser. */
const MAX_SESSIONS = 5;
/** The key of a session begun before anyone signed in. */
const NO_ONE = '';

type StoredSession = { sessionId: string; lastActivityAt: number };
/**
 * The live sessions, by whose they are: a hash of the token subject of the user active
 * on it, or `NO_ONE`. Hashed because the sessions live in a cookie, which goes with every
 * request to the site, and the subject is the user's id. One each, so two tabs signed in
 * as different users each keep their own visit.
 */
type Sessions = Record<string, StoredSession>;

/** The sessions, in shared storage under `key`, which names the workspace. */
export type SessionStore = { storage: KeyValueStorage; key: string };

/**
 * The session activity was recorded on: whether it just `started`, and `borrowedFrom`,
 * the user whose session activity before sign-in continued.
 */
export type TouchedSession = {
  sessionId: string;
  started: boolean;
  borrowedFrom?: string;
};

/** Ends `owner`'s session, or with no owner given, every session. */
export function endSession(store: SessionStore, owner?: string): void {
  if (owner === undefined) {
    store.storage.removeItem(store.key);
    return;
  }

  const sessions = liveSessions(store);
  delete sessions[claimedKey(sessions, owner)];
  save(store, sessions);
}

/**
 * Records `owner`'s activity on their session. `started` is true if a new one began.
 * Activity with no one signed in (a page loading before `identify()`) continues the
 * latest live session, whoever's: a reload doesn't end a signed-in user's visit. Such a
 * session is `borrowedFrom` that user, so it's left out of the events if someone else
 * adopts them. A session begun before sign-in becomes the user's who signs in.
 */
export function touchSession(store: SessionStore, owner: string | null): TouchedSession {
  const sessions = liveSessions(store);

  let key: string;
  if (owner === null) {
    key = latest(sessions) ?? NO_ONE;
  } else {
    key = claimedKey(sessions, owner);
  }

  const current = sessions[key];
  const sessionId = current ? current.sessionId : uuid();
  sessions[key] = { sessionId, lastActivityAt: Date.now() };
  save(store, sessions);

  const touched: TouchedSession = { sessionId, started: !current };
  if (owner === null && key !== NO_ONE) {
    touched.borrowedFrom = key;
  }
  return touched;
}

/**
 * Extends `owner`'s session (as `touchSession` picks it) without starting one, so time on
 * a visible page never ends a visit but a timer alone never begins one.
 */
export function keepSessionAlive(store: SessionStore, owner: string | null): void {
  const sessions = liveSessions(store);
  const key = owner === null ? latest(sessions) : claimedKey(sessions, owner);
  if (key === undefined || !sessions[key]) {
    return;
  }

  sessions[key].lastActivityAt = Date.now();
  save(store, sessions);
}

/**
 * The key of `owner`'s session in `sessions`. With none of their own yet, the visit
 * begun before sign-in (as the page loaded) becomes theirs, so whatever they do next,
 * keeping it alive or signing out, is done to that visit.
 */
function claimedKey(sessions: Sessions, owner: string): string {
  const key = sessionOwner(owner);
  if (!sessions[key] && sessions[NO_ONE]) {
    sessions[key] = sessions[NO_ONE];
    delete sessions[NO_ONE];
  }
  return key;
}

/** Saves the newest `MAX_SESSIONS` of `sessions`, or removes them all if there are none. */
function save({ storage, key }: SessionStore, sessions: Sessions): void {
  const kept = Object.entries(sessions).sort(newestFirst).slice(0, MAX_SESSIONS);
  if (kept.length === 0) {
    storage.removeItem(key);
  } else {
    storage.setItem(key, JSON.stringify(Object.fromEntries(kept)));
  }
}

/** The sessions that haven't timed out; none if unreadable. */
function liveSessions({ storage, key }: SessionStore): Sessions {
  const stored = readJson(storage, key);
  const live: Sessions = {};
  if (typeof stored !== 'object' || stored === null) {
    return live;
  }

  for (const [owner, session] of Object.entries(stored as Record<string, unknown>)) {
    const { sessionId, lastActivityAt } = (session ?? {}) as Partial<StoredSession>;
    if (
      typeof sessionId === 'string' &&
      typeof lastActivityAt === 'number' &&
      Date.now() - lastActivityAt < SESSION_TIMEOUT_MS
    ) {
      live[owner] = { sessionId, lastActivityAt };
    }
  }
  return live;
}

/** Whose session was active last, if any is live. */
function latest(sessions: Sessions): string | undefined {
  const [newest] = Object.entries(sessions).sort(newestFirst);
  return newest ? newest[0] : undefined;
}

function newestFirst(
  [, a]: [string, StoredSession],
  [, b]: [string, StoredSession],
): number {
  return b.lastActivityAt - a.lastActivityAt;
}

/**
 * The key `subject`'s session is kept under, and that `borrowedFrom` names: a 53-bit hash
 * of it (cyrb53), enough to tell two users apart without storing who either is.
 */
export function sessionOwner(subject: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < subject.length; index++) {
    const code = subject.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
