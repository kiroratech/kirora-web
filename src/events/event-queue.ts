import type { KeyValueStorage } from '../storage/device-storage.js';
import { STORAGE_KEYS } from '../storage/keys.js';
import { KiroraError } from '../errors.js';
import { utf8Length } from '../utils/utf8.js';

/** As `POST /events/batch` expects it. The idempotency key makes resends safe. */
export type QueuedEvent = {
  idempotencyKey: string;
  name: string;
  properties: Record<string, unknown>;
  occurredAt: string;
  /** Where and on what it happened (after `beforeSend`). The queue only stores it. */
  context: Record<string, unknown>;
};

/**
 * Who an event belongs to: the signed-in user's token subject when it was tracked, or
 * null before sign-in until a sign-in adopts it. Kept on the device only, never sent.
 */
type EventOwner = string | null;

type StoredEvent = { owner: EventOwner; event: QueuedEvent };

/**
 * The queue as last read or written, the exact string stored for it and that string's
 * UTF-8 size. `exact` is false if reading dropped unreadable entries, so the string has
 * more than `stored`.
 */
type Cache = {
  json: string | null;
  bytes: number;
  stored: StoredEvent[];
  exact: boolean;
};

/**
 * Past either, the oldest events are dropped (e.g. after a long time offline). The bytes
 * are the stored JSON's, owners included, and well under the usual 5 MB `localStorage`
 * quota, which the site shares with us.
 */
const MAX_QUEUED_EVENTS = 1000;
const MAX_QUEUED_BYTES = 1_000_000;

/**
 * Persistent queue shared by all tabs, one per workspace. Each operation re-reads storage
 * under a Web Lock so tabs don't overwrite each other's events.
 *
 * Events tracked before sign-in wait without an owner until a sign-in adopts them, in one
 * locked step, so two tabs can't both take them. An event with an owner only ever goes as
 * that user.
 */
export class EventQueue {
  private readonly key: string;
  /**
   * The queue as last read or written, and the exact string stored for it. Another tab's
   * write changes the string, so a mismatch means parse again; a match skips the parse.
   */
  private cache: Cache = { json: null, bytes: 0, stored: [], exact: true };
  /** Events added this tick, not yet written: they're saved together, in one write. */
  private batch: { stored: StoredEvent[]; written: Promise<number> } | undefined;

  constructor(
    private readonly storage: KeyValueStorage,
    namespace: string,
  ) {
    this.key = STORAGE_KEYS.events(namespace);
  }

  /** Returns how many events wait. Rejects an event too large to keep at all. */
  add(event: QueuedEvent, owner: EventOwner): Promise<number> {
    // `[` and `]` around it, were it the only one.
    if (utf8Length(JSON.stringify({ owner, event })) + 2 > MAX_QUEUED_BYTES) {
      return Promise.reject(
        new KiroraError('the event is larger than the queue can keep'),
      );
    }
    if (this.batch) {
      this.batch.stored.push({ owner, event });
      return this.batch.written;
    }
    const stored = [{ owner, event }];
    const written = this.exclusively(() => {
      // Later adds start a batch of their own.
      if (this.batch?.stored === stored) this.batch = undefined;
      this.read();
      const { kept, json, bytes } = appended(this.cache, stored);
      this.write(kept, json, bytes);
      return kept.length;
    });
    this.batch = { stored, written };
    return written;
  }

  /** `owner`'s oldest events: only an event's own user ever sends it. */
  oldest(count: number, owner: string): Promise<QueuedEvent[]> {
    return this.exclusively(() =>
      this.read()
        .filter((stored) => stored.owner === owner)
        .slice(0, count)
        .map((stored) => stored.event),
    );
  }

  /**
   * Makes the events from before sign-in `owner`'s, as they sign in: from now on they
   * go as `owner` or not at all, whoever signs in next or in another tab. Returns their
   * idempotency keys, for `release()`.
   */
  adopt(owner: string): Promise<Set<string>> {
    return this.exclusively(() => {
      const stored = this.read();
      const adopted = new Set<string>();
      for (const entry of stored) {
        if (entry.owner === null) adopted.add(entry.event.idempotencyKey);
      }
      if (adopted.size > 0 || !this.cache.exact) {
        this.write(
          stored.map((entry) => (entry.owner === null ? { ...entry, owner } : entry)),
        );
      }
      return adopted;
    });
  }

  /**
   * Undoes `adopt()` for those of `keys` still waiting as `owner`'s, as a sign-in turns
   * out to have failed: they wait for the next sign-in again.
   */
  release(owner: string, keys: ReadonlySet<string>): Promise<void> {
    return this.exclusively(() => {
      const stored = this.read();
      const released = (entry: StoredEvent) =>
        entry.owner === owner && keys.has(entry.event.idempotencyKey);
      if (!stored.some(released)) return;
      this.write(
        stored.map((entry) => (released(entry) ? { ...entry, owner: null } : entry)),
      );
    });
  }

  remove(idempotencyKeys: ReadonlySet<string>): Promise<void> {
    if (idempotencyKeys.size === 0) return Promise.resolve();
    return this.keep((stored) => !idempotencyKeys.has(stored.event.idempotencyKey));
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
    if (json !== this.cache.json) {
      this.cache = { json, bytes: utf8Length(json ?? ''), ...parse(json) };
    }
    return this.cache.stored;
  }

  private write(
    stored: StoredEvent[],
    json = JSON.stringify(stored),
    bytes = utf8Length(json),
  ): void {
    const empty = stored.length === 0;
    if (empty) this.storage.removeItem(this.key);
    else this.storage.setItem(this.key, json);
    this.cache = {
      json: empty ? null : json,
      bytes: empty ? 0 : bytes,
      stored,
      exact: true,
    };
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

/**
 * The queue with `adding` at the end, dropping the oldest past the count or byte limit
 * (`add()` has refused any event over the limit alone), with its JSON and that JSON's
 * size. Built from the stored JSON when that matches the queue exactly, rather than
 * encoding up to a megabyte again per event.
 */
function appended(
  cache: Cache,
  adding: StoredEvent[],
): { kept: StoredEvent[]; json: string; bytes: number } {
  const all = [...cache.stored, ...adding];
  const addingJson = JSON.stringify(adding);
  // An array's JSON is `[` + its items' JSON joined by `,` + `]`.
  const reuse = cache.exact && cache.json !== null && cache.stored.length > 0;
  const json = reuse
    ? `${cache.json!.slice(0, -1)},${addingJson.slice(1)}`
    : JSON.stringify(all);
  let bytes = reuse ? cache.bytes + utf8Length(addingJson) - 1 : utf8Length(json);
  let first = 0;
  /** Where the kept items start in `json`. */
  let start = 1;
  while (
    first < all.length - 1 &&
    (all.length - first > MAX_QUEUED_EVENTS || bytes > MAX_QUEUED_BYTES)
  ) {
    // The item and the comma after it.
    const item = JSON.stringify(all[first]);
    start += item.length + 1;
    bytes -= utf8Length(item) + 1;
    first++;
  }
  return first === 0
    ? { kept: all, json, bytes }
    : { kept: all.slice(first), json: `[${json.slice(start)}`, bytes };
}
