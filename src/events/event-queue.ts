import type { KeyValueStorage } from '../storage/device-storage.js';
import { STORAGE_KEYS } from '../storage/keys.js';

/** As `POST /events/batch` expects it. The idempotency key makes resends safe. */
export type QueuedEvent = {
  idempotencyKey: string;
  name: string;
  properties: Record<string, unknown>;
  occurredAt: string;
  /** Where and on what it happened. The queue only stores it. */
  context: Record<string, unknown> & { sessionId?: string; device: { id: string } };
};

/**
 * Who an event belongs to: the signed-in user's token subject when it was tracked, or
 * null before sign-in. Kept on the device only, never sent.
 */
type EventOwner = string | null;

type StoredEvent = { owner: EventOwner; event: QueuedEvent };

/**
 * The queue as last read or written, and the exact string stored for it. `exact` is
 * false if reading dropped unreadable entries, so the string has more than `stored`.
 */
type Cache = { json: string | null; stored: StoredEvent[]; exact: boolean };

/** Past either, the oldest events are dropped (e.g. after a long time offline). */
const MAX_QUEUED_EVENTS = 1000;
/** Well under the usual 5 MB `localStorage` quota, which the site shares with us. */
const MAX_QUEUED_CHARACTERS = 1_000_000;

/**
 * Persistent queue shared by all tabs, one per workspace. Each operation re-reads storage
 * under a Web Lock so tabs don't overwrite each other's events.
 *
 * Events tracked before sign-in go as whoever signs in next. An event tracked while a
 * user was signed in only ever goes as that user.
 */
export class EventQueue {
  private readonly key: string;
  /**
   * The queue as last read or written, and the exact string stored for it. Another tab's
   * write changes the string, so a mismatch means parse again; a match skips the parse.
   */
  private cache: Cache = { json: null, stored: [], exact: true };
  /** Events added this tick, not yet written: they're saved together, in one write. */
  private batch: { stored: StoredEvent[]; written: Promise<number> } | undefined;

  constructor(
    private readonly storage: KeyValueStorage,
    namespace: string,
  ) {
    this.key = STORAGE_KEYS.events(namespace);
  }

  /** Returns how many events wait. */
  add(event: QueuedEvent, owner: EventOwner): Promise<number> {
    if (this.batch) {
      this.batch.stored.push({ owner, event });
      return this.batch.written;
    }
    const stored = [{ owner, event }];
    const written = this.exclusively(() => {
      // Later adds start a batch of their own.
      if (this.batch?.stored === stored) this.batch = undefined;
      this.read();
      const { kept, json } = appended(this.cache, stored);
      this.write(kept, json);
      return kept.length;
    });
    this.batch = { stored, written };
    return written;
  }

  /** The oldest events `owner` may send: their own, and those from before sign-in. */
  oldest(count: number, owner: EventOwner): Promise<QueuedEvent[]> {
    return this.exclusively(() =>
      this.read()
        .filter((stored) => sendableBy(stored, owner))
        .slice(0, count)
        .map((stored) => stored.event),
    );
  }

  remove(idempotencyKeys: ReadonlySet<string>): Promise<void> {
    if (idempotencyKeys.size === 0) return Promise.resolve();
    return this.keep((stored) => !idempotencyKeys.has(stored.event.idempotencyKey));
  }

  /** Forgets what `owner` could send: their events and those from before sign-in. */
  clear(owner: EventOwner): Promise<void> {
    return this.keep((stored) => !sendableBy(stored, owner));
  }

  /**
   * Forgets the events `test` picks of those with an owner, leaving those from before
   * sign-in to whoever's next.
   */
  clearOwnedBy(test: (owner: string, event: QueuedEvent) => boolean): Promise<void> {
    return this.keep(
      (stored) => stored.owner === null || !test(stored.owner, stored.event),
    );
  }

  clearAll(): Promise<void> {
    return this.keep(() => false);
  }

  /** Rewrites the queue without what `test` rejects, if that's anything or it's unreadable. */
  private keep(test: (stored: StoredEvent) => boolean): Promise<void> {
    return this.exclusively(() => {
      const stored = this.read();
      const kept = stored.filter(test);
      if (kept.length < stored.length || !this.cache.exact) this.write(kept);
    });
  }

  /** The stored queue, parsed only if it changed since we last read or wrote it. */
  private read(): StoredEvent[] {
    const json = this.storage.getItem(this.key);
    if (json !== this.cache.json) this.cache = { json, ...parse(json) };
    return this.cache.stored;
  }

  private write(stored: StoredEvent[], json = JSON.stringify(stored)): void {
    if (stored.length === 0) this.storage.removeItem(this.key);
    else this.storage.setItem(this.key, json);
    this.cache = { json: stored.length === 0 ? null : json, stored, exact: true };
  }

  /**
   * Runs `operation` under a cross-tab lock, or unlocked where Web Locks aren't supported.
   * Operations run in the order they're asked for, so an add asked for after another
   * operation joins no batch from before it.
   */
  private exclusively<Result>(operation: () => Result): Promise<Result> {
    this.batch = undefined;
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    // Always a tick later, even where a free lock is granted at once, so adds made in the
    // same tick have joined their batch by the time it's written.
    return Promise.resolve().then(() =>
      locks
        ? // Async, so a throwing operation still releases the lock (Node keeps it otherwise).
          // eslint-disable-next-line @typescript-eslint/require-await
          locks.request(this.key, async () => operation())
        : operation(),
    );
  }
}

/** The stored queue. Skips anything unreadable rather than losing the whole queue to it. */
function parse(json: string | null): Pick<Cache, 'stored' | 'exact'> {
  let entries: unknown;
  try {
    entries = JSON.parse(json ?? '[]');
  } catch {
    return { stored: [], exact: false };
  }
  if (!Array.isArray(entries)) return { stored: [], exact: false };
  const stored = (entries as Partial<StoredEvent>[]).filter(
    (entry): entry is StoredEvent =>
      typeof entry?.event?.idempotencyKey === 'string' &&
      (entry.owner === null || typeof entry.owner === 'string'),
  );
  return { stored, exact: stored.length === entries.length };
}

/** An owner may send their own events and those from before sign-in. */
function sendableBy(stored: StoredEvent, owner: EventOwner): boolean {
  return stored.owner === null || stored.owner === owner;
}

/**
 * The queue with `adding` at the end, dropping the oldest past the count or size limit
 * but always keeping the newest, and its JSON. Built from the stored JSON when that
 * matches the queue exactly, rather than encoding up to a megabyte again per event.
 */
function appended(
  cache: Cache,
  adding: StoredEvent[],
): { kept: StoredEvent[]; json: string } {
  const all = [...cache.stored, ...adding];
  // An array's JSON is `[` + its items' JSON joined by `,` + `]`.
  const json =
    cache.exact && cache.json !== null && cache.stored.length > 0
      ? `${cache.json.slice(0, -1)},${JSON.stringify(adding).slice(1)}`
      : JSON.stringify(all);
  let first = 0;
  /** Where the kept items start in `json`. */
  let start = 1;
  while (
    first < all.length - 1 &&
    (all.length - first > MAX_QUEUED_EVENTS ||
      json.length - start + 1 > MAX_QUEUED_CHARACTERS)
  ) {
    start += JSON.stringify(all[first]).length + 1;
    first++;
  }
  return first === 0
    ? { kept: all, json }
    : { kept: all.slice(first), json: `[${json.slice(start)}` };
}
