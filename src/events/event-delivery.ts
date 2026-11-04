import type { ClientApi } from '../api/client-api.js';
import type { Identity, SignedInUser } from '../identity/identity.js';
import { KiroraApiError, UserTokenError } from '../errors.js';
import type { TrackingConsent } from '../tracking/consent.js';
import type { EventQueue, QueuedEvent } from './event-queue.js';
import type { Log } from '../utils/log.js';

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
    // The running send may have read the queue before the latest events were added.
    if (this.flushing) {
      const runNext = () => {
        this.nextFlush = null;
        return this.flushWhenDue();
      };
      this.nextFlush ??= this.flushing.then(runNext, runNext);
      return this.nextFlush;
    }
    this.flushing = this.send().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
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
    let maxEvents = EVENT_BATCH_SIZE;
    const mayStillSend = () =>
      this.identity.user === user && !this.destroyed && this.consent.allowed;
    while (mayStillSend()) {
      const hidden = isPageHidden();
      const { batch, bytes } = fitBatch(
        await this.queue.oldest(maxEvents, user.subject),
        hidden ? MAX_KEEPALIVE_BYTES : MAX_BATCH_BYTES,
      );
      // Consent may have been withdrawn, or the user changed, while the queue was read.
      if (batch.length === 0 || !mayStillSend()) return;
      // A single event too large for keepalive goes without it rather than not at all.
      const outcome = await this.sendBatch(
        user,
        batch,
        hidden && bytes <= MAX_KEEPALIVE_BYTES,
      );
      if (outcome === 'split') {
        maxEvents = Math.ceil(batch.length / 2);
        continue;
      }
      if (outcome === 'stop') return;
      await this.queue.remove(outcome);
      // Past the event a split isolated, the rest go in full batches again.
      maxEvents = EVENT_BATCH_SIZE;
      if (outcome.size < batch.length) {
        this.log('error', "Kirora's answer didn't cover every event; retrying the rest");
        this.retryLater();
        return;
      }
      this.resetBackoff();
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
    try {
      const sent = await this.api.request<unknown>('POST', '/events/batch', {
        // Lets the server correct for clock skew.
        body: { sentAt: new Date().toISOString(), events: batch },
        keepalive,
        as: user,
      });
      const settled = this.acknowledgedKeys(sent, batchKeys);
      this.log('debug', `Sent ${settled.size} events`);
      return settled;
    } catch (error) {
      return this.classifyFailure(error, batchKeys);
    }
  }

  /** What a failed batch means: try later, stop, split it, or drop it as refused. */
  private classifyFailure(
    error: unknown,
    batchKeys: Set<string>,
  ): Set<string> | 'split' | 'stop' {
    if (!(error instanceof KiroraApiError) || error.retryable) {
      // Offline, timed out, 429/5xx, or the token fetch failed: keep them, retry later.
      if (error instanceof UserTokenError) this.log('error', error.message, error.cause);
      this.retryLater(error);
      return 'stop';
    }
    // Still refused after a token refresh, or the user changed: keep the events for the
    // next identify() as their own user.
    if (error.status === 401) {
      this.log('error', 'Events not sent', error);
      return 'stop';
    }
    // Too large or invalid: retry in halves until we isolate the bad event, so the rest of
    // the batch still goes.
    if (SPLIT_STATUSES.includes(error.status) && batchKeys.size > 1) return 'split';
    // Any other 4xx will fail every time, so drop the batch instead of blocking the queue.
    this.log(
      'error',
      error.code === 'PLAN_FEATURE_UNAVAILABLE'
        ? "Events dropped: this workspace's plan doesn't record custom events"
        : 'Events dropped: Kirora refused them',
      error,
    );
    return batchKeys;
  }

  /** Whether a failure's delay still applies. Only our own backoff can be skipped. */
  private mustWait(skipBackoff: boolean): boolean {
    return Date.now() < this.notBefore && (this.delayFromServer || !skipBackoff);
  }

  /**
   * The events Kirora answered for, accepted or refused. Refusals are final (the event
   * itself is invalid), so they're logged and settled too. Anything unanswered stays.
   */
  private acknowledgedKeys(sent: unknown, batchKeys: ReadonlySet<string>): Set<string> {
    const results = (sent as { results?: unknown } | undefined)?.results;
    const settled = new Set<string>();
    if (!Array.isArray(results)) return settled;
    for (const result of results as { idempotencyKey?: unknown; error?: unknown }[]) {
      const key = result?.idempotencyKey;
      if (typeof key !== 'string' || !batchKeys.has(key)) continue;
      settled.add(key);
      if (result.error) this.log('error', 'Event refused', result);
    }
    return settled;
  }

  /** Backs off, doubling up to 5 minutes, and never sooner than `Retry-After`. */
  private retryLater(error?: unknown): void {
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

  private resetBackoff(): void {
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

/** As many events as fit in `maxBytes`, but always at least one, and their size. */
function fitBatch(
  events: QueuedEvent[],
  maxBytes: number,
): { batch: QueuedEvent[]; bytes: number } {
  const encoder = new TextEncoder();
  let bytes = ENVELOPE_BYTES;
  for (const [index, event] of events.entries()) {
    const eventBytes = encoder.encode(JSON.stringify(event)).length + 1;
    if (bytes + eventBytes > maxBytes && index > 0) {
      return { batch: events.slice(0, index), bytes };
    }
    bytes += eventBytes;
  }
  return { batch: events, bytes };
}

/** ±10%, so clients don't all retry at the same moment. */
function jittered(delayMs: number): number {
  return delayMs * (1 - JITTER + Math.random() * 2 * JITTER);
}

/** While hidden, requests use keepalive so they survive the tab closing. */
function isPageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}
