import { isPageHidden } from '../utils/page-hidden.js';
import type { KeyValueStorage } from '../storage/device-storage.js';
import {
  forgetRevision,
  LockUnavailable,
  readRevision,
  withCrossTabLock,
  writeRevision,
} from '../storage/cross-tab-lock.js';
import { wait } from '../utils/timeout.js';
import { STORAGE_KEY_PREFIX, STORAGE_KEYS } from '../storage/keys.js';
import { sessionOwner } from '../tracking/session.js';
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
export type EventOwner = string | null;

/**
 * `sessionOwner`: for an event tracked before sign-in that continued a signed-in user's
 * session (a reload), whose session it was, as `sessionOwner()` names them.
 */
type StoredEvent = { owner: EventOwner; event: QueuedEvent; sessionOwner?: string };

/**
 * The queue as last read or written, the exact string stored for it and, if it's been
 * counted, that string's UTF-8 size. `exact` is false if reading dropped unreadable
 * entries, so the string has more than `stored`.
 */
type Cache = {
  json: string | null;
  bytes?: number;
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

/** Another tab that wrote the queue this recently may still be writing it. */
const OTHER_TAB_ACTIVE_MS = 10_000;

/** How long `localStorage` is waited for before going ahead regardless. */
const MAX_CATCH_UP_MS = 100;

/** Long enough for another tab's write to arrive: a task alone isn't, in Chromium. */
const CATCH_UP_PAUSE_MS = 1;

/** Events added in one tick, waiting to be written together. */
type PendingBatch = {
  stored: StoredEvent[];
  /** Each event's JSON, encoded as it was added, so the write reuses it. */
  jsons: string[];
  /** Written at once as the page hid, so its locked write has nothing left to do. */
  writtenEarly: boolean;
  /** Resolves with how many events wait once the batch is written. */
  written: Promise<number>;
};

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
  private batch: PendingBatch | undefined;

  /** Beside the queue: the revision of the write it shows (see `readRevision`). */
  private readonly revisionKey: string;
  /** Writes made, to tell whether a locked operation wrote. */
  private writes = 0;
  /** This tab's operations other than adds still waiting for, or holding, the lock. */
  private waiting = 0;

  constructor(
    private readonly storage: KeyValueStorage & { readonly persistent?: boolean },
    namespace: string,
  ) {
    this.key = STORAGE_KEYS.events(namespace);
    this.revisionKey = STORAGE_KEYS.eventsRevision(namespace);
    watchOtherTabs();
  }

  /** Returns how many events wait. Rejects an event too large to keep at all. */
  add(event: QueuedEvent, owner: EventOwner, sessionOwner?: string): Promise<number> {
    const entry: StoredEvent = { owner, event };
    if (sessionOwner !== undefined) {
      entry.sessionOwner = sessionOwner;
    }

    // Encoded once, here: the write reuses it.
    const json = JSON.stringify(entry);

    // `[` and `]` around it, were it the only one.
    if (mayExceed(json, 2) && utf8Length(json) + 2 > MAX_QUEUED_BYTES) {
      return Promise.reject(
        new KiroraError('the event is larger than the queue can keep'),
      );
    }

    // Only with none of this tab's other operations waiting: written ahead of them, the
    // event could be cleared by one asked for before it (consent withdrawn, say).
    if (isPageHidden() && this.waiting === 0) {
      return Promise.resolve(this.addNow(entry, json));
    }

    if (this.batch) {
      this.batch.stored.push(entry);
      this.batch.jsons.push(json);
      return this.batch.written;
    }

    const batch: PendingBatch = {
      stored: [entry],
      jsons: [json],
      writtenEarly: false,
      written: Promise.resolve(0),
    };
    batch.written = this.exclusively(() => this.writeBatch(batch));
    this.batch = batch;
    return batch.written;
  }

  /** Writes `batch`, under the lock, and returns how many events wait. */
  private writeBatch(batch: PendingBatch): number {
    // Later adds start a batch of their own.
    if (this.batch === batch) {
      this.batch = undefined;
    }
    // Written already, as the page was hidden.
    if (batch.writtenEarly) {
      return this.read().length;
    }
    return this.append(batch.stored, batch.jsons);
  }

  /**
   * Writes `entry` at once, unlocked, with the batch still waiting, and returns how many
   * events wait. For a hidden page, which may be closing before a lock is granted: only
   * another tab writing in the same instant could race it, and losing the event to the
   * page closing is likelier.
   */
  private addNow(entry: StoredEvent, json: string): number {
    const stored = [entry];
    const jsons = [json];

    // The batch waiting goes first, written now too, so its locked write has nothing
    // left to do; later adds start a batch of their own.
    const waiting = this.batch;
    if (waiting) {
      stored.unshift(...waiting.stored);
      jsons.unshift(...waiting.jsons);
      waiting.writtenEarly = true;
      this.batch = undefined;
    }

    // Counted like a locked write, so a tab under the lock waits to see it.
    const { result, revision } = this.run(() => this.append(stored, jsons), 0);
    if (revision) {
      writeRevision(this.key, revision).catch(() => undefined);
    }
    return result;
  }

  /**
   * `owner`'s oldest events: only an event's own user ever sends it. `now` reads them at
   * once, unlocked, with those added but not yet written: as the page goes away, a locked
   * read comes too late to send anything. A read alone can't lose another tab's events.
   */
  oldest(count: number, owner: string, now = false): Promise<QueuedEvent[]> {
    const pick = () => {
      const notYetWritten = now && this.batch ? this.batch.stored : [];
      return [...this.read(), ...notYetWritten]
        .filter((stored) => stored.owner === owner)
        .slice(0, count)
        .map((stored) => stored.event);
    };

    if (now) {
      return Promise.resolve(pick());
    }
    return this.inTurn(pick);
  }

  /**
   * Makes the events from before sign-in `owner`'s, as they sign in: from now on they
   * go as `owner` or not at all, whoever signs in next or in another tab. One that
   * continued another user's session leaves that session out, so the two users' visits
   * aren't joined. Nothing moves once `stillSignedIn()` is false: another sign-in replaced
   * this one while it waited for the lock. Returns their idempotency keys, for
   * `release()`.
   */
  adopt(owner: string, stillSignedIn: () => boolean): Promise<Set<string>> {
    const ownSession = sessionOwner(owner);

    const withoutOthersSession = (adopted: StoredEvent): StoredEvent => {
      const borrowed =
        adopted.sessionOwner !== undefined && adopted.sessionOwner !== ownSession;
      if (!borrowed) {
        return adopted;
      }

      const context = { ...adopted.event.context };
      delete context.sessionId;
      // The marker stays, so an event `release()` gives back is checked again at the
      // next adoption.
      return { ...adopted, event: { ...adopted.event, context } };
    };

    return this.reassign(null, owner, () => stillSignedIn(), withoutOthersSession);
  }

  /**
   * Undoes `adopt()` for those of `keys` still waiting as `owner`'s, as a sign-in turns
   * out to have failed: they wait for the next sign-in again.
   */
  async release(owner: string, keys: ReadonlySet<string>): Promise<void> {
    await this.reassign(owner, null, (event) => keys.has(event.idempotencyKey));
  }

  remove(idempotencyKeys: ReadonlySet<string>): Promise<void> {
    if (idempotencyKeys.size === 0) {
      return Promise.resolve();
    }
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

  /**
   * The idempotency keys of the events waiting from before sign-in, as of now: `all`
   * of them, and those `borrowed` from a signed-in user's session, as a reload before
   * `identify()` tracks them.
   */
  unboundKeys(): Promise<{ all: Set<string>; borrowed: Set<string> }> {
    return this.inTurn(() => {
      const all = new Set<string>();
      const borrowed = new Set<string>();
      for (const stored of this.read()) {
        if (stored.owner !== null) {
          continue;
        }
        all.add(stored.event.idempotencyKey);
        if (stored.sessionOwner !== undefined) {
          borrowed.add(stored.event.idempotencyKey);
        }
      }
      return { all, borrowed };
    });
  }

  /** Forgets those of `keys` still waiting from before sign-in; adopted ones stay. */
  removeUnbound(keys: ReadonlySet<string>): Promise<void> {
    if (keys.size === 0) {
      return Promise.resolve();
    }
    return this.keep(
      (stored) => stored.owner !== null || !keys.has(stored.event.idempotencyKey),
    );
  }

  /** Forgets every event, and the count of writes kept beside them: nothing is left. */
  async clearAll(): Promise<void> {
    await this.keep(() => false);
    // Both copies, or every tab would wait for a revision `localStorage` no longer shows.
    this.storage.removeItem(this.revisionKey);
    await forgetRevision(this.key).catch(() => undefined);
  }

  /**
   * Gives `to` the events of `from` that `picks` picks, in one locked step, and returns
   * their idempotency keys.
   */
  private reassign(
    from: EventOwner,
    to: EventOwner,
    picks: (event: QueuedEvent) => boolean = () => true,
    adjust: (entry: StoredEvent) => StoredEvent = (entry) => entry,
  ): Promise<Set<string>> {
    return this.inTurn(() => {
      const moved = new Set<string>();
      const stored = this.read().map((entry) => {
        if (entry.owner !== from || !picks(entry.event)) {
          return entry;
        }
        moved.add(entry.event.idempotencyKey);
        return adjust({ ...entry, owner: to });
      });
      if (moved.size > 0 || !this.cache.exact) {
        this.write(stored);
      }
      return moved;
    });
  }

  /** Rewrites the queue without what `test` rejects, if that's anything or it's unreadable. */
  private keep(test: (stored: StoredEvent) => boolean): Promise<void> {
    return this.inTurn(() => {
      const stored = this.read();
      const kept = stored.filter(test);
      if (kept.length < stored.length || !this.cache.exact) {
        this.write(kept);
      }
    });
  }

  /** The stored queue, parsed only if it changed since we last read or wrote it. */
  private read(): StoredEvent[] {
    const json = this.storage.getItem(this.key);
    // Its size is only counted if an add needs it.
    if (json !== this.cache.json) {
      this.cache = { json, ...parse(json) };
    }
    return this.cache.stored;
  }

  private write(
    stored: StoredEvent[],
    json = JSON.stringify(stored),
    bytes?: number,
  ): void {
    this.writes++;

    // Emptied by removing the key, except where this page fell back to memory: there,
    // removing it would delete what other tabs have stored since.
    const empty = stored.length === 0 && this.storage.persistent !== false;
    if (empty) {
      this.storage.removeItem(this.key);
    } else {
      this.storage.setItem(this.key, json);
    }

    this.cache = {
      json: empty ? null : json,
      bytes: empty ? 0 : bytes,
      stored,
      exact: true,
    };
  }

  /** Appends `stored` (whose JSON is `jsons`) and returns how many events wait. */
  private append(stored: StoredEvent[], jsons: string[]): number {
    this.read();
    const appending = appended(this.cache, stored, jsons);
    this.write(appending.kept, appending.json, appending.bytes);
    return appending.kept.length;
  }

  /**
   * `exclusively`, counted while it waits: an add while the page is hidden is written at
   * once only with none of these waiting, so it can't jump one asked for before it.
   */
  private inTurn<Result>(operation: () => Result): Promise<Result> {
    // An add asked for after this joins no batch from before it, so it's written after.
    this.batch = undefined;

    this.waiting++;
    const done = this.exclusively(operation);
    const finished = () => {
      this.waiting--;
    };
    done.then(finished, finished);
    return done;
  }

  /**
   * Runs `operation` under a lock every tab shares: a Web Lock, or where there are none
   * or they're refused (an opaque-origin frame), an IndexedDB transaction. Unlocked only
   * where neither works (IndexedDB refused in a private window, or never opening).
   * Operations run in the order they're asked for.
   */
  private exclusively<Result>(operation: () => Result): Promise<Result> {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;

    // Always a tick later, even where a free lock is granted at once, so adds made in the
    // same tick have joined their batch by the time it's written.
    return Promise.resolve().then(() => {
      if (!locks) {
        return this.underIndexedDbLock(operation);
      }

      let ran = false;
      const underWebLock = () => {
        ran = true;
        return this.caughtUpThen(operation);
      };
      // Refused without running (an opaque-origin frame): the IndexedDB lock instead.
      return locks.request(this.key, underWebLock).catch((error: unknown) => {
        if (ran) {
          throw error;
        }
        return this.underIndexedDbLock(operation);
      });
    });
  }

  /**
   * Under the Web Lock: waits for this tab's `localStorage` to show the latest write any
   * tab made (see `readRevision`), runs `operation`, and records its write's revision.
   */
  private async caughtUpThen<Result>(operation: () => Result): Promise<Result> {
    // A page fallen back to memory neither sees other tabs' writes nor shares its own:
    // there's nothing to catch up with.
    if (this.storage.persistent === false) {
      return operation();
    }

    const latest = await readRevision(this.key).catch(() => undefined);
    if (latest === undefined) {
      // Without IndexedDB (some private windows) nothing says which write to wait for.
      // While another tab is writing the queue, a moment lets its latest write arrive: in
      // Chromium that cut the events lost between two busy tabs from about 20% to 0.3%.
      if (writtenElsewhereLately(this.key)) {
        await wait(CATCH_UP_PAUSE_MS);
      }
      return operation();
    }

    // Never for good, as every tab waits on the lock meanwhile: a write lost to a full
    // quota in another tab never shows. By time, as a hidden tab's timers are throttled.
    const giveUpAt = Date.now() + MAX_CATCH_UP_MS;
    while (this.revision() < latest && Date.now() < giveUpAt) {
      await wait(CATCH_UP_PAUSE_MS);
    }

    const { result, revision } = this.run(operation, latest);
    if (revision) {
      await writeRevision(this.key, revision).catch(() => undefined);
    }
    return result;
  }

  /**
   * Under the IndexedDB lock, where there are no Web Locks: tried again shortly while
   * `localStorage` hasn't caught up. Unlocked only where IndexedDB can't be used.
   */
  private async underIndexedDbLock<Result>(operation: () => Result): Promise<Result> {
    if (typeof indexedDB === 'undefined') {
      return operation();
    }

    const giveUpAt = Date.now() + MAX_CATCH_UP_MS;
    // A page fallen back to memory has nothing to catch up with, as above.
    const shared = this.storage.persistent !== false;
    const runIfCaughtUp = (latest: number) => {
      const behind = shared && this.revision() < latest && Date.now() < giveUpAt;
      if (behind) {
        return undefined;
      }
      return this.run(operation, latest);
    };

    while (true) {
      let done: { result: Result } | undefined;
      try {
        done = await withCrossTabLock(this.key, runIfCaughtUp);
      } catch (error) {
        if (error instanceof LockUnavailable) {
          return operation();
        }
        throw error;
      }
      if (done) {
        return done.result;
      }

      // Not caught up yet: the lock is let go, and asked for again shortly.
      await wait(CATCH_UP_PAUSE_MS);
    }
  }

  /**
   * Runs `operation` and, if it wrote (to storage other tabs share), records the write's
   * revision after `latest` beside the queue, and returns it for IndexedDB.
   */
  private run<Result>(
    operation: () => Result,
    latest: number,
  ): { result: Result; revision?: number } {
    const writes = this.writes;
    const result = operation();

    const wroteShared = this.writes !== writes && this.storage.persistent !== false;
    if (!wroteShared) {
      return { result };
    }

    const revision = Math.max(latest, this.revision()) + 1;
    this.storage.setItem(this.revisionKey, String(revision));
    return { result, revision };
  }

  /** The revision of the latest write this tab's `localStorage` shows. */
  private revision(): number {
    return Number(this.storage.getItem(this.revisionKey)) || 0;
  }
}

/** When another tab last wrote each `localStorage` key, as `storage` events tell. */
const writtenElsewhere = new Map<string, number>();
let watchingOtherTabs = false;

function watchOtherTabs(): void {
  if (watchingOtherTabs || typeof addEventListener !== 'function') {
    return;
  }
  watchingOtherTabs = true;
  addEventListener('storage', ({ key }) => {
    // Only the SDK's own: the site's keys are none of its business.
    if (key?.startsWith(STORAGE_KEY_PREFIX)) {
      writtenElsewhere.set(key, Date.now());
    }
  });
}

/** Whether another tab wrote `key` in the last few seconds. */
function writtenElsewhereLately(key: string): boolean {
  return Date.now() - (writtenElsewhere.get(key) ?? 0) < OTHER_TAB_ACTIVE_MS;
}

/** The stored queue. Skips anything unreadable rather than losing the whole queue to it. */
function parse(json: string | null): Pick<Cache, 'stored' | 'exact'> {
  let entries: unknown;
  try {
    entries = JSON.parse(json ?? '[]');
  } catch {
    return { stored: [], exact: false };
  }
  if (!Array.isArray(entries)) {
    return { stored: [], exact: false };
  }
  const stored = (entries as Partial<StoredEvent>[]).filter(
    (entry): entry is StoredEvent =>
      typeof entry?.event?.idempotencyKey === 'string' &&
      (entry.owner === null || typeof entry.owner === 'string'),
  );
  return { stored, exact: stored.length === entries.length };
}

/**
 * True if `json`, with `extra` bytes more, could be over the byte limit. UTF-8 takes at
 * most 3 bytes a character, so most strings never need counting.
 */
function mayExceed(json: string, extra = 0): boolean {
  return json.length * 3 + extra > MAX_QUEUED_BYTES;
}

/**
 * The queue with `adding` (whose JSON is `addingJsons`) at the end, dropping the oldest
 * past the count or byte limit (`add()` has refused any event over the limit alone), with
 * its JSON and, if counted, that JSON's size.
 */
function appended(
  cache: Cache,
  adding: StoredEvent[],
  addingJsons: string[],
): { kept: StoredEvent[]; json: string; bytes?: number } {
  const all = [...cache.stored, ...adding];
  // An array's JSON is `[` + its items' JSON joined by `,` + `]`.
  const items = addingJsons.join(',');
  const json = appendedJson(cache, items);
  let bytes = mayExceed(json) ? appendedBytes(cache, json, items) : undefined;

  // Drops the oldest until within both limits, always keeping the newest.
  let first = 0;
  // Where the kept items start in `json`.
  let start = 1;
  const overLimit = () => {
    const tooMany = all.length - first > MAX_QUEUED_EVENTS;
    const tooLarge = bytes !== undefined && bytes > MAX_QUEUED_BYTES;
    return tooMany || tooLarge;
  };
  while (first < all.length - 1 && overLimit()) {
    // The item and the comma after it.
    const item = JSON.stringify(all[first]);
    start += item.length + 1;
    if (bytes !== undefined) {
      bytes -= utf8Length(item) + 1;
    }
    first++;
  }

  if (first === 0) {
    return { kept: all, json, bytes };
  }
  return { kept: all.slice(first), json: `[${json.slice(start)}`, bytes };
}

/**
 * The stored queue's JSON with `items` added at the end. Built from the stored string
 * when it matches the queue exactly, rather than encoding up to a megabyte again.
 */
function appendedJson(cache: Cache, items: string): string {
  if (cache.stored.length === 0) {
    return `[${items}]`;
  }
  const before = reusableJson(cache) ?? JSON.stringify(cache.stored);
  return `${before.slice(0, -1)},${items}]`;
}

/** The UTF-8 size of `json`: counted on from the stored size where that's known. */
function appendedBytes(cache: Cache, json: string, items: string): number {
  const reused = reusableJson(cache) !== null && cache.stored.length > 0;
  if (reused && cache.bytes !== undefined) {
    return cache.bytes + 1 + utf8Length(items);
  }
  return utf8Length(json);
}

/** The stored string, if it's exactly the queue cached. */
function reusableJson(cache: Cache): string | null {
  return cache.exact ? cache.json : null;
}
