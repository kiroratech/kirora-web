import { readJson, type KeyValueStorage } from '../storage/device-storage.js';
import { STORAGE_KEYS } from '../storage/keys.js';
import { uuid } from '../utils/uuid.js';

/** Its properties say how the visitor arrived. */
export const SESSION_STARTED_EVENT = 'Session Started';

/** The usual 30-minute inactivity timeout. */
const SESSION_TIMEOUT_MS = 30 * 60_000;
/** How often a visible page keeps its session alive: well inside the timeout. */
export const SESSION_KEEPALIVE_MS = 5 * 60_000;

type StoredSession = { sessionId: string; lastActivityAt: number };

export function endSession(storage: KeyValueStorage): void {
  storage.removeItem(STORAGE_KEYS.session);
}

/** Records activity on the current session. `started` is true if a new one began. */
export function touchSession(storage: KeyValueStorage): {
  sessionId: string;
  started: boolean;
} {
  const current = liveSessionId(storage);
  const sessionId = current ?? uuid();
  save(storage, sessionId);
  return { sessionId, started: current === null };
}

/**
 * Extends the current session without starting a new one, so time on a visible page
 * never ends a visit but a timer alone never begins one.
 */
export function keepSessionAlive(storage: KeyValueStorage): void {
  const sessionId = liveSessionId(storage);
  if (sessionId !== null) save(storage, sessionId);
}

/** Records activity on `sessionId` now. */
function save(storage: KeyValueStorage, sessionId: string): void {
  const session: StoredSession = { sessionId, lastActivityAt: Date.now() };
  storage.setItem(STORAGE_KEYS.session, JSON.stringify(session));
}

/** The session id, unless there's none or it timed out. */
function liveSessionId(storage: KeyValueStorage): string | null {
  const stored = readJson(storage, STORAGE_KEYS.session) as StoredSession | null;
  return stored && Date.now() - stored.lastActivityAt < SESSION_TIMEOUT_MS
    ? stored.sessionId
    : null;
}
