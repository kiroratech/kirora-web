import { MAX_TIMER_MS } from '../utils/timeout.js';
import { isPageHidden } from '../utils/page-hidden.js';
import type { ClientApi } from '../api/client-api.js';
import type { Identity, SignedInUser } from '../identity/identity.js';
import { fieldErrors, KiroraApiError, retryAfterOf, UserTokenError } from '../errors.js';
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
/**
 * Kirora's one refusal of a whole batch that holds for good: the plan lacks the feature.
 * Any other 4xx (a 403, 404 or 409, say) never comes from `/events/batch` itself but from
 * a wrong `apiUrl`, a proxy or a captive portal, so the events are kept and retried.
 */
const TERMINAL_CODES = ['PLAN_FEATURE_UNAVAILABLE'];
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
   * The batches being sent, by the user each is for, to cancel them: all as consent is
   * withdrawn, or an earlier sign-in's as the same user signs in again. One may be for
   * the user signed in now, and one for a user who has since signed out.
   */
  private readonly sending = new Map<AbortController, SignedInUser>();
  /**
   * The idempotency keys of the events on their way, which another send skips: while the
   * page is hidden, sends don't wait for each other.
   */
  private readonly inFlight = new Set<string>();
  /**
   * Bytes of keepalive requests on their way: the browser allows 64 KiB in all, so sends
   * while hidden share our 60 KB between them.
   */
  private keepaliveBytes = 0;

  /**
   * The events the latest sign-in adopted, until Kirora accepts that user's token on any
   * request. A token refused before then means the sign-in failed, so they're given back.
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
    for (const sending of this.sending.keys()) {
      sending.abort();
    }
  }

  /**
   * Makes the events from before sign-in `user`'s, as they sign in. Given back if Kirora
   * refuses their token before accepting any request.
   */
  async adopt(user: SignedInUser): Promise<void> {
    // Nothing for a sign-in a later identify() or logout() replaced while this waited for
    // the lock: the events are for whoever is signed in by then.
    const keys = await this.queue.adopt(user.subject, () => this.identity.user === user);
    this.adoption = keys.size > 0 ? { user, keys } : undefined;
  }

  /** After an event is queued: send at once if enough wait, otherwise soon. */
  onEventQueued(waiting: number): void {
    if (!this.identity.user) {
      return;
    }
    // Hidden, the page may be closing: an event tracked as it goes goes with it.
    if (waiting >= FLUSH_AT_EVENTS || isPageHidden()) {
      void this.flushWhenDue();
    } else {
      this.schedule(Date.now() + FLUSH_INTERVAL_MS);
    }
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
    const { user } = this.identity;
    const sendingAs = this.sendingAs;

    // The running send may have read the queue before the latest events were added, so
    // one for the same user is waited for, then this goes again: two at once would read
    // the same events. One for a user no longer signed in is left to itself, so the next
    // user's events don't wait on its answer (after a logout gave up waiting, say). While
    // the page is hidden nothing waits, as the answer would come after the page has gone:
    // the new send skips the events already on their way.
    const sameUserSending = sendingAs?.subject === user?.subject;
    if (this.flushing && sameUserSending && !isPageHidden()) {
      // The same user identified again: their earlier sign-in's send is cancelled first,
      // so the wait is short.
      if (sendingAs && sendingAs !== user) {
        this.abortSendsFor(sendingAs);
      }
      return this.afterRunningSend(this.flushing);
    }

    // Never rejects: it's started by timers and page events, where nothing would catch it.
    const sending = this.send()
      .catch((error: unknown) => this.log('error', 'Events not sent', error))
      .finally(() => {
        if (this.flushing === sending) {
          this.flushing = null;
        }
      });
    this.flushing = sending;
    return sending;
  }

  /** Flushes once `running` ends; calls made meanwhile share that one flush. */
  private afterRunningSend(running: Promise<void>): Promise<void> {
    if (!this.nextFlush) {
      const runNext = () => {
        this.nextFlush = null;
        return this.flushWhenDue();
      };
      this.nextFlush = running.then(runNext, runNext);
    }
    return this.nextFlush;
  }

  /** Cancels the batches on their way for `user`, signed in before. Kept for a retry. */
  private abortSendsFor(user: SignedInUser): void {
    for (const [sending, sendingAs] of this.sending) {
      if (sendingAs === user) {
        sending.abort();
      }
    }
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
    if (this.destroyed) {
      return;
    }

    // Bound to the user signed in now. If the app changes user, the next identify()
    // flushes for them. A token refused for good would be refused again: nothing goes
    // until identify() signs in again.
    const { user } = this.identity;
    if (!user || this.identity.tokenRefused(user)) {
      return;
    }
    if (this.mustWait(skipBackoff)) {
      this.schedule(this.notBefore);
      return;
    }

    this.sendingAs = user;
    let maxEvents = EVENT_BATCH_SIZE;
    const mayStillSend = () =>
      this.identity.user === user && !this.destroyed && this.consent.allowed;

    while (mayStillSend()) {
      const hidden = isPageHidden();
      // Read at once while hidden: the page may be going away.
      // Reads extra, to skip the events another send already has on their way.
      const wanted = maxEvents + this.inFlight.size;
      const oldest = await this.queue.oldest(wanted, user.subject, hidden);
      // Marked as on their way in the same step, before another send can read them.
      const { batch, bytes } = this.nextBatch(oldest, maxEvents, hidden);

      // Consent may have been withdrawn, or the user changed, while the queue was read.
      if (batch.length === 0 || !mayStillSend()) {
        return;
      }

      const outcome = await this.whileOnTheirWay(batch, hidden ? bytes : 0, async () => {
        const sent = await this.sendBatch(user, batch, hidden);
        // Still on their way until removed, so another send can't pick them up again.
        if (sent.kind === 'settled') {
          await this.queue.remove(sent.keys);
        }
        return sent;
      });

      if (outcome.kind === 'split') {
        maxEvents = Math.ceil(batch.length / 2);
        continue;
      }
      if (outcome.kind === 'stop') {
        return;
      }

      // Past the event a split isolated, the rest go in full batches again.
      maxEvents = EVENT_BATCH_SIZE;

      const unsettled = batch.length - outcome.keys.size;
      if (unsettled > 0) {
        this.log('debug', `Retrying ${unsettled} events later`);
        // Never sooner than the answer's Retry-After, as for a 429.
        this.retryLater(user, undefined, outcome.retryAfterMs);
        return;
      }
      this.resetBackoff(user);
    }
  }

  /**
   * The batch to send from `oldest`, and its size. Events already on their way in
   * another send are left to it.
   */
  private nextBatch(
    oldest: QueuedEvent[],
    maxEvents: number,
    hidden: boolean,
  ): { batch: QueuedEvent[]; bytes: number } {
    const notInFlight = oldest.filter(
      (event) => !this.inFlight.has(event.idempotencyKey),
    );
    // Read extra to skip those in flight, but never more than a batch takes.
    return fitBatch(notInFlight.slice(0, maxEvents), hidden, this.keepaliveBytes);
  }

  /**
   * Runs `step` with `batch` marked as on its way, and its `keepaliveBytes` counted
   * against the browser's keepalive limit, until `step` ends.
   */
  private async whileOnTheirWay<Result>(
    batch: QueuedEvent[],
    keepaliveBytes: number,
    step: () => Promise<Result>,
  ): Promise<Result> {
    const keys = batch.map((event) => event.idempotencyKey);
    for (const key of keys) {
      this.inFlight.add(key);
    }
    this.keepaliveBytes += keepaliveBytes;

    try {
      return await step();
    } finally {
      this.keepaliveBytes -= keepaliveBytes;
      for (const key of keys) {
        this.inFlight.delete(key);
      }
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
  ): Promise<BatchOutcome> {
    const batchKeys = new Set(batch.map((event) => event.idempotencyKey));
    const sending = new AbortController();
    this.sending.set(sending, user);

    // The answer's Retry-After, for what it leaves unsettled.
    let retryAfterMs = 0;
    try {
      const sent = await this.api.request<unknown>('POST', '/events/batch', {
        // Lets the server correct for clock skew.
        body: { sentAt: new Date().toISOString(), events: batch },
        keepalive,
        as: user,
        signal: sending.signal,
        onRetryAfter: (delayMs) => {
          retryAfterMs = delayMs;
        },
      });
      const keys = this.acknowledgedKeys(sent, batchKeys);
      this.log('debug', `Sent ${keys.size} events`);
      return { kind: 'settled', keys, retryAfterMs };
    } catch (error) {
      // Cancelled on purpose, as consent was withdrawn: not a failure to retry.
      if (sending.signal.aborted) {
        return STOP;
      }
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
  ): BatchOutcome {
    if (!(error instanceof KiroraApiError) || error.retryable) {
      // Offline, timed out, 429/5xx, or the token fetch failed: keep them, retry later.
      if (error instanceof UserTokenError) {
        this.log('error', error.message, error.cause);
        this.identity.authFailed(user, 'fetch_failed');
      }
      this.retryLater(user, error);
      return STOP;
    }
    // Still refused after a token refresh, or the user changed: the events wait for the
    // next identify() as their own user, and those this sign-in adopted are given back.
    // Retried with backoff only if a fresh token can be asked for: a token passed to
    // identify() would be refused every time, which Identity remembers.
    if (error.status === 401) {
      this.log('error', 'Events not sent', error);
      this.giveBackAdopted(user);
      this.identity.authFailed(user, 'refused');
      if (!this.identity.tokenRefused(user)) {
        this.retryLater(user);
      }
      return STOP;
    }
    // Too large or invalid: retry in halves until we isolate the bad event, so the rest of
    // the batch still goes.
    const blamesEvents = blamesAnEvent(error);
    if (blamesEvents && batchKeys.size > 1) {
      return { kind: 'split' };
    }
    if (blamesEvents || TERMINAL_CODES.includes(error.code ?? '')) {
      this.log('error', `${batchKeys.size} events dropped: Kirora refused them`, {
        status: error.status,
        code: error.code,
      });
      return { kind: 'settled', keys: batchKeys, retryAfterMs: 0 };
    }
    // Not Kirora's answer to the batch: keep the events, as for a network failure.
    this.log('error', `Events not sent: answered ${error.status}; retrying later`, {
      code: error.code,
    });
    this.retryLater(user, error);
    return STOP;
  }

  /**
   * A sign-in whose token Kirora never accepted gives back the events it adopted. One
   * Kirora accepted on any request (a push registration, say) stands: its events stay
   * the user's, so a logout clears them rather than leaving them to the next user.
   */
  private giveBackAdopted(user: SignedInUser): void {
    const { adoption } = this;
    if (adoption?.user !== user) {
      return;
    }
    this.adoption = undefined;
    if (user.accepted) {
      return;
    }
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
    if (!Array.isArray(results)) {
      return new Set();
    }
    // Each of this batch's events answered for once; one answered more than once could
    // mean either, so it's kept for a retry.
    const answers = new Map<string, BatchResult>();
    const answeredTwice = new Set<string>();
    for (const result of results as BatchResult[]) {
      const key = result?.idempotencyKey;
      if (typeof key !== 'string' || !batchKeys.has(key)) {
        continue;
      }
      if (answers.has(key)) {
        answeredTwice.add(key);
      }
      answers.set(key, result);
    }

    const settled = new Set<string>();
    const refusals = new Map<string, number>();
    for (const [key, result] of answers) {
      if (answeredTwice.has(key)) {
        continue;
      }

      const code = refusalCode(result);
      if (code === undefined) {
        if (isReceipt(result)) {
          settled.add(key);
        }
        continue;
      }

      if (!RETRYABLE_EVENT_CODES.includes(code)) {
        settled.add(key);
        refusals.set(code, (refusals.get(code) ?? 0) + 1);
      }
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
  private retryLater(user: SignedInUser, error?: unknown, serverDelayMs = 0): void {
    if (this.identity.user !== user) {
      return;
    }
    const retryAfterMs = retryAfterOf(error) || serverDelayMs;
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
    if (this.identity.user !== user) {
      return;
    }
    this.retryDelayMs = FLUSH_INTERVAL_MS;
    this.notBefore = 0;
    this.delayFromServer = false;
  }

  /** Flushes at `at`, or sooner if one is already due then, but never before `notBefore`. */
  private schedule(at: number): void {
    if (this.destroyed) {
      return;
    }
    const due = Math.max(at, this.notBefore);
    if (this.timer !== undefined && this.timerAt <= due) {
      return;
    }
    clearTimeout(this.timer);
    this.timerAt = due;
    // A longer delay overflows, and browsers fire at once: it waits and re-arms instead.
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.flushWhenDue();
      },
      Math.min(due - Date.now(), MAX_TIMER_MS),
    );
  }
}

/**
 * As many of `events`, oldest first, as fit in one request: 200 KB, or while the page is
 * hidden, what's left of keepalive's 60 KB with `keepaliveBytes` on their way. Always at
 * least one, except that while hidden an event too large for what's left is skipped: it
 * waits for the page to be shown again (a request without keepalive could be cut off as
 * the tab closes), and those behind it go.
 */
function fitBatch(
  events: QueuedEvent[],
  hidden: boolean,
  keepaliveBytes: number,
): { batch: QueuedEvent[]; bytes: number } {
  const maxBytes = hidden ? MAX_KEEPALIVE_BYTES - keepaliveBytes : MAX_BATCH_BYTES;
  const batch: QueuedEvent[] = [];
  let bytes = ENVELOPE_BYTES;
  for (const event of events) {
    const size = eventBytes(event);
    if (hidden && ENVELOPE_BYTES + size > maxBytes) {
      continue;
    }
    if (batch.length > 0 && bytes + size > maxBytes) {
      break;
    }
    batch.push(event);
    bytes += size;
  }
  return { batch, bytes };
}

/**
 * Whether Kirora's refusal of a batch blames events in it, so halving it finds the event
 * to drop. A 413 does; a 400 or 422 only if its `errors` name a field under `events`.
 * Otherwise it's a problem with the request (a header, or a proxy answering every
 * request), so the events are kept: halving would refuse, and drop, every one of them.
 */
function blamesAnEvent(error: KiroraApiError): boolean {
  if (error.status === 413) {
    return true;
  }
  if (error.status !== 400 && error.status !== 422) {
    return false;
  }

  const errors = fieldErrors.get(error) ?? [];
  return errors.some(
    (fieldError) =>
      fieldError?.in === 'body' &&
      typeof fieldError.field === 'string' &&
      /^events(\.|$)/.test(fieldError.field),
  );
}

/**
 * What became of a batch: the events it settled (sent, or refused for good), with the
 * answer's Retry-After for any it didn't; or that it should be split; or that sending
 * should stop for now.
 */
type BatchOutcome =
  | { kind: 'settled'; keys: Set<string>; retryAfterMs: number }
  | { kind: 'split' }
  | { kind: 'stop' };

const STOP: BatchOutcome = { kind: 'stop' };

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
