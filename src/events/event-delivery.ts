import type { ClientApi } from '../api/client-api.js';
import type { Identity, SignedInUser } from '../identity/identity.js';
import { KiroraApiError, UserTokenError } from '../errors.js';
import type { TrackingConsent } from '../tracking/consent.js';
import type { EventQueue, QueuedEvent } from './event-queue.js';
import type { Log } from '../utils/log.js';
import { utf8Length } from '../utils/utf8.js';

/** The API accepts at most 100 events per batch. */
const EVENT_BATCH_SIZE = 100;
/** Stays under the server's body limit. A 413 gets split anyway. */
const MAX_BATCH_BYTES = 200_000;
/** Browsers cap in-flight keepalive requests at 64 KB in total. */
const MAX_KEEPALIVE_BYTES = 60_000;
/** `{"sentAt":"…","events":[]}` around the events. */
const ENVELOPE_BYTES = 64;
/** Flush at 20 queued events, otherwise 30 seconds after the first one waits. */
const FLUSH_AT_EVENTS = 20;
const FLUSH_INTERVAL_MS = 30_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
/** Answers that blame something in the batch: halving it finds the event to drop. */
const SPLIT_STATUSES = [400, 413, 422];
/** Per-event refusals that a later attempt may not get: the event is kept and retried. */
const RETRYABLE_EVENT_CODES = ['RATE_LIMITED', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE'];
/** Retry delays vary by this fraction, so clients don't all retry at once. */
const JITTER = 0.1;

/**
 * Sends queued events in batches, retrying with backoff. Each user's events are only
 * ever sent with that user's token, and nothing is sent without tracking consent: events
 * a visitor hasn't consented to yet (e.g. queued before consent was required) wait.
 */
export class EventDelivery {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerAt = 0;
  private flushing: Promise<void> | null = null;
  /** Who the running send is for, to tell whether the next one may join it. */
  private sendingAs: SignedInUser | null = null;
  private nextFlush: Promise<void> | null = null;
  /** A flush() asked to skip our own backoff: the next send does, whoever started it. */
  private backoffWaived = false;
  private retryDelayMs = FLUSH_INTERVAL_MS;
  /** No send before this (epoch ms), after a failure. */
  private notBefore = 0;
  /**
   * True when `notBefore` is the server's `Retry-After`, which nothing may cut short.
   * Our own backoff can be: by a manual flush, the page hiding, or coming back online.
   */
  private delayFromServer = false;
  private destroyed = false;
  /**
   * Cancels the batches being sent, e.g. as consent is withdrawn: one for the user
   * signed in now, and one still under way for a user who has since signed out.
   */
  private readonly sending = new Set<AbortController>();
  /**
   * The events the latest sign-in adopted, until Kirora accepts a batch as that user. A
   * token refused before then means the sign-in failed, so they're given back.
   */
  private adoption: { user: SignedInUser; keys: Set<string> } | undefined;

  constructor(
    private readonly api: ClientApi,
    private readonly identity: Identity,
    private readonly queue: EventQueue,
    private readonly consent: Pick<TrackingConsent, 'allowed'>,
    private readonly log: Log,
  ) {}

  /** Stops for good: no more timers or sends. Queued events stay stored. */
  destroy(): void {
    this.destroyed = true;
    this.stop();
  }

  /**
   * Cancels the scheduled send and the batch on its way, as tracking consent is
   * withdrawn. What Kirora already accepted can't be recalled.
   */
  cancel(): void {
    this.stop();
    for (const sending of this.sending) sending.abort();
  }

  /**
   * Makes the events from before sign-in `user`'s, as they sign in. Given back if Kirora
   * refuses their token before accepting a batch.
   */
  async adopt(user: SignedInUser): Promise<void> {
    const keys = await this.queue.adopt(user.subject);
    this.adoption = keys.size > 0 ? { user, keys } : undefined;
  }

  /** After an event is queued: send at once if enough wait, otherwise soon. */
  onEventQueued(waiting: number): void {
    if (!this.identity.user) return;
    if (waiting >= FLUSH_AT_EVENTS) void this.flushWhenDue();
    else this.schedule(Date.now() + FLUSH_INTERVAL_MS);
  }

  /**
   * Sends queued events now, if a user is signed in, without waiting out our own backoff
   * (never the server's `Retry-After`). Resolves once sending stops, which doesn't mean
   * every event was accepted: some may wait for a retry.
   */
  flush(): Promise<void> {
    this.backoffWaived = true;
    return this.flushWhenDue();
  }

  /**
   * Sends once any backoff has passed, for timers and a full queue. One send at a time:
   * if one is running, goes again after it.
   */
  private flushWhenDue(): Promise<void> {
    // The running send may have read the queue before the latest events were added. One
    // for a user no longer signed in is left to itself instead, so the next user's events
    // don't wait on an answer for it, e.g. after a logout gave up waiting for one.
    if (this.flushing && this.sendingAs === this.identity.user) {
      const runNext = () => {
        this.nextFlush = null;
        return this.flushWhenDue();
      };
      this.nextFlush ??= this.flushing.then(runNext, runNext);
      return this.nextFlush;
    }
    const sending = this.send().finally(() => {
      if (this.flushing === sending) this.flushing = null;
    });
    this.flushing = sending;
    return sending;
  }

  private stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Sends batch after batch for the user signed in now, until the queue is empty. */
  private async send(): Promise<void> {
    this.stop();
    const skipBackoff = this.backoffWaived;
    this.backoffWaived = false;
    if (this.destroyed) return;
    if (this.mustWait(skipBackoff)) {
      this.schedule(this.notBefore);
      return;
    }
    // Bound to the user signed in now. If the app changes user, the next identify()
    // flushes for them.
    const { user } = this.identity;
    if (!user) return;
    this.sendingAs = user;
    let maxEvents = EVENT_BATCH_SIZE;
    const mayStillSend = () =>
      this.identity.user === user && !this.destroyed && this.consent.allowed;
    while (mayStillSend()) {
      const hidden = isPageHidden();
      const batch = fitBatch(await this.queue.oldest(maxEvents, user.subject), hidden);
      // Consent may have been withdrawn, or the user changed, while the queue was read.
      if (batch.length === 0 || !mayStillSend()) return;
      const outcome = await this.sendBatch(user, batch, hidden);
      if (outcome === 'split') {
        maxEvents = Math.ceil(batch.length / 2);
        continue;
      }
      if (outcome === 'stop') return;
      await this.queue.remove(outcome);
      // Past the event a split isolated, the rest go in full batches again.
      maxEvents = EVENT_BATCH_SIZE;
      if (outcome.size < batch.length) {
        this.log('debug', `Retrying ${batch.length - outcome.size} events later`);
        this.retryLater(user);
        return;
      }
      this.resetBackoff(user);
    }
  }

  /**
   * Sends one batch. Returns the events it settled (sent, or refused for good), or that
   * the batch should be split, or that sending should stop for now.
   */
  private async sendBatch(
    user: SignedInUser,
    batch: QueuedEvent[],
    keepalive: boolean,
  ): Promise<Set<string> | 'split' | 'stop'> {
    const batchKeys = new Set(batch.map((event) => event.idempotencyKey));
    const sending = new AbortController();
    this.sending.add(sending);
    try {
      const sent = await this.api.request<unknown>('POST', '/events/batch', {
        // Lets the server correct for clock skew.
        body: { sentAt: new Date().toISOString(), events: batch },
        keepalive,
        as: user,
        signal: sending.signal,
      });
      // Kirora took the token: what this sign-in adopted is its for good.
      if (this.adoption?.user === user) this.adoption = undefined;
      const settled = this.acknowledgedKeys(sent, batchKeys);
      this.log('debug', `Sent ${settled.size} events`);
      return settled;
    } catch (error) {
      // Cancelled on purpose, as consent was withdrawn: not a failure to retry.
      if (sending.signal.aborted) return 'stop';
      return this.classifyFailure(user, error, batchKeys);
    } finally {
      this.sending.delete(sending);
    }
  }

  /** What a failed batch means: try later, stop, split it, or drop it as refused. */
  private classifyFailure(
    user: SignedInUser,
    error: unknown,
    batchKeys: Set<string>,
  ): Set<string> | 'split' | 'stop' {
    if (!(error instanceof KiroraApiError) || error.retryable) {
      // Offline, timed out, 429/5xx, or the token fetch failed: keep them, retry later.
      if (error instanceof UserTokenError) this.log('error', error.message, error.cause);
      this.retryLater(user, error);
      return 'stop';
    }
    // Still refused after a token refresh, or the user changed: the events wait for the
    // next identify() as their own user, and those this sign-in adopted are given back.
    // Retried with backoff only if a fresh token can be asked for: a token passed to
    // identify() would be refused every time.
    if (error.status === 401) {
      this.log('error', 'Events not sent', error);
      this.giveBackAdopted(user);
      if (this.identity.canRefresh) this.retryLater(user);
      return 'stop';
    }
    // Too large or invalid: retry in halves until we isolate the bad event, so the rest of
    // the batch still goes.
    if (SPLIT_STATUSES.includes(error.status) && batchKeys.size > 1) return 'split';
    // Any other 4xx will fail every time, so drop the batch instead of blocking the queue.
    this.log('error', `${batchKeys.size} events dropped: Kirora refused them`, {
      status: error.status,
      code: error.code,
    });
    return batchKeys;
  }

  /** A sign-in whose token Kirora never accepted gives back the events it adopted. */
  private giveBackAdopted(user: SignedInUser): void {
    const { adoption } = this;
    if (adoption?.user !== user) return;
    this.adoption = undefined;
    this.queue
      .release(user.subject, adoption.keys)
      .catch((error: unknown) => this.log('error', "Couldn't release events", error));
  }

  /** Whether a failure's delay still applies. Only our own backoff can be skipped. */
  private mustWait(skipBackoff: boolean): boolean {
    return Date.now() < this.notBefore && (this.delayFromServer || !skipBackoff);
  }

  /**
   * The events Kirora answered for once each, recorded or refused for good (logged by
   * code, never with the event). Kept for a retry: a refusal a later attempt may not
   * get, an event with no answer, one answered more than once, which could mean either,
   * and one whose answer is neither a receipt nor a refusal.
   */
  private acknowledgedKeys(sent: unknown, batchKeys: ReadonlySet<string>): Set<string> {
    const results = (sent as { results?: unknown } | undefined)?.results;
    if (!Array.isArray(results)) return new Set();
    const answers = new Map<string, BatchResult[]>();
    for (const result of results as BatchResult[]) {
      const key = result?.idempotencyKey;
      if (typeof key !== 'string' || !batchKeys.has(key)) continue;
      answers.set(key, [...(answers.get(key) ?? []), result]);
    }
    const settled = new Set<string>();
    const refusals = new Map<string, number>();
    for (const [key, [result, ...more]] of answers) {
      // Answered more than once could mean either.
      if (more.length > 0) continue;
      const code = refusalCode(result!);
      if (code === undefined) {
        if (isReceipt(result!)) settled.add(key);
        continue;
      }
      if (RETRYABLE_EVENT_CODES.includes(code)) continue;
      settled.add(key);
      refusals.set(code, (refusals.get(code) ?? 0) + 1);
    }
    for (const [code, count] of refusals) {
      this.log('error', `${count} events refused by Kirora: ${code}`);
    }
    return settled;
  }

  /**
   * Backs off, doubling up to 5 minutes, and never sooner than `Retry-After`, if `user` is
   * still signed in. A send still finishing for one who has signed out (e.g. after their
   * logout gave up waiting) leaves the next user's timing alone.
   */
  private retryLater(user: SignedInUser, error?: unknown): void {
    if (this.identity.user !== user) return;
    const retryAfterMs = (error instanceof KiroraApiError && error.retryAfterMs) || 0;
    // Jitter only ever adds to the server's delay, so throttled clients spread out.
    const delayMs = Math.max(
      jittered(this.retryDelayMs),
      retryAfterMs * (1 + Math.random() * JITTER),
    );
    this.notBefore = Date.now() + delayMs;
    this.delayFromServer = retryAfterMs > 0;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_DELAY_MS);
    this.schedule(this.notBefore);
  }

  /** Clears the backoff after a success, if `user` is still signed in (as `retryLater`). */
  private resetBackoff(user: SignedInUser): void {
    if (this.identity.user !== user) return;
    this.retryDelayMs = FLUSH_INTERVAL_MS;
    this.notBefore = 0;
    this.delayFromServer = false;
  }

  /** Flushes at `at`, or sooner if one is already due then, but never before `notBefore`. */
  private schedule(at: number): void {
    if (this.destroyed) return;
    const due = Math.max(at, this.notBefore);
    if (this.timer !== undefined && this.timerAt <= due) return;
    clearTimeout(this.timer);
    this.timerAt = due;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushWhenDue();
    }, due - Date.now());
  }
}

/**
 * As many of `events`, oldest first, as fit in one request: 200 KB, or 60 KB while the
 * page is hidden, as keepalive allows. Always at least one, except that while hidden an
 * event too large for keepalive is skipped: it waits for the page to be shown again (a
 * request without keepalive could be cut off as the tab closes), and those behind it go.
 */
function fitBatch(events: QueuedEvent[], hidden: boolean): QueuedEvent[] {
  const maxBytes = hidden ? MAX_KEEPALIVE_BYTES : MAX_BATCH_BYTES;
  const batch: QueuedEvent[] = [];
  let bytes = ENVELOPE_BYTES;
  for (const event of events) {
    const size = eventBytes(event);
    if (hidden && ENVELOPE_BYTES + size > maxBytes) continue;
    if (batch.length > 0 && bytes + size > maxBytes) break;
    batch.push(event);
    bytes += size;
  }
  return batch;
}

/** One event's answer in `POST /events/batch`, as far as it can be trusted. */
type BatchResult = {
  idempotencyKey?: unknown;
  event?: unknown;
  replayed?: unknown;
  error?: unknown;
};

/** The refusal's code, if the result is a well-formed refusal. */
function refusalCode(result: BatchResult): string | undefined {
  const code = (result.error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code !== '' ? code : undefined;
}

/** True if the result is Kirora's receipt for a recorded event. */
function isReceipt(result: BatchResult): boolean {
  return (
    result.error === undefined &&
    typeof result.replayed === 'boolean' &&
    typeof result.event === 'object' &&
    result.event !== null
  );
}

/** An event's size in a batch: its JSON and the comma after it. */
function eventBytes(event: QueuedEvent): number {
  return utf8Length(JSON.stringify(event)) + 1;
}

/** ±10%, so clients don't all retry at the same moment. */
function jittered(delayMs: number): number {
  return delayMs * (1 - JITTER + Math.random() * 2 * JITTER);
}

/** While hidden, requests use keepalive so they survive the tab closing. */
function isPageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}
