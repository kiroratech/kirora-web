import type { EventDelivery } from '../events/event-delivery.js';
import type { EventOwner, EventQueue, QueuedEvent } from '../events/event-queue.js';
import type { Identity } from '../identity/identity.js';
import type { KeyValueStorage } from '../storage/device-storage.js';
import type { BeforeSendEvent, EventProperties, KiroraOptions } from '../types.js';
import { jsonSnapshot, NotJsonError } from '../utils/json-snapshot.js';
import type { Log } from '../utils/log.js';
import { uuid } from '../utils/uuid.js';
import type { TrackingConsent } from './consent.js';
import {
  eventTime,
  PAGE_VIEWED_EVENT,
  pageContext,
  sessionStartedProperties,
  type PageContext,
} from './page-context.js';
import * as sessions from './session.js';

/** Only what the tracker uses of each part, so it depends on no more. */
type TrackerDependencies = {
  identity: Pick<Identity, 'owner'>;
  queue: Pick<EventQueue, 'add' | 'clearAll'>;
  delivery: Pick<EventDelivery, 'onEventQueued'>;
  consent: Pick<TrackingConsent, 'allowed'>;
  /** Shared across subdomains, so `www.` and `app.` see the same device and session. */
  siteStorage: KeyValueStorage;
  /** Where the session is kept, per workspace. */
  sessionKey: string;
  /** `device.id`, made on first use. */
  deviceId: () => string;
  trackSessions: boolean;
  beforeSend: KiroraOptions['beforeSend'];
  log: Log;
};

/**
 * Turns what the app tracks into queued events: their time, page, session and device,
 * owned by whoever is signed in. Nothing is recorded without tracking consent, and
 * nothing here throws: a failure is logged, so it never breaks the host page.
 */
export class Tracker {
  /** True while `beforeSend` runs, so tracking from inside it is refused. */
  private inBeforeSend = false;
  /**
   * True from a sign-out in this tab until the next sign-in: activity meanwhile is no one's,
   * and never continues another user's live session, as it would on a page load.
   */
  private signedOutHere = false;

  constructor(private readonly parts: TrackerDependencies) {}

  /** Builds the event right away so its time and page are accurate, then queues it. */
  track(name: string, properties: EventProperties): void {
    this.safely(() => this.record(name, properties));
  }

  /** Tracks `Page Viewed`, with the page copied into properties so segments can filter on it. */
  trackPageView(): void {
    this.safely(() => {
      if (!this.parts.consent.allowed) {
        return;
      }
      const page = pageContext();
      this.record(PAGE_VIEWED_EVENT, { ...page.page }, page);
    });
  }

  /** Activity keeps the session alive, or starts a new one with `Session Started`. */
  noteActivity(): void {
    this.safely(() => this.continueSession(this.owner()));
  }

  /** Extends the current session without starting one, e.g. while the page is visible. */
  keepSessionAlive(): void {
    this.safely(() => {
      if (this.sessionsOn) {
        sessions.keepSessionAlive(this.sessionStore, this.owner(), this.borrowing());
      }
    });
  }

  /** Ends every session, as when consent is withdrawn. */
  endSession(): void {
    this.safely(() => sessions.endSession(this.sessionStore));
  }

  /** `subject` signed out in this tab: their session ends, and borrowing stops. */
  signedOut(subject: string): void {
    this.stopBorrowingSessions();
    this.safely(() => sessions.endSession(this.sessionStore, subject));
  }

  /**
   * Activity here is no one's until the next sign-in, never continuing another user's
   * live session, as it does on a page load: after a sign-out in this tab.
   */
  stopBorrowingSessions(): void {
    this.signedOutHere = true;
  }

  /** Forgets queued events and the session, as when consent is withdrawn. */
  forget(): void {
    this.parts.queue
      .clearAll()
      .catch((error: unknown) => this.parts.log('error', "Couldn't clear events", error));
    this.endSession();
  }

  private get sessionStore(): sessions.SessionStore {
    return { storage: this.parts.siteStorage, key: this.parts.sessionKey };
  }

  /** Who owns what's tracked now: no one while logout() signs the user out. */
  private owner(): EventOwner {
    return this.parts.identity.owner?.subject ?? null;
  }

  /** The page is only looked at once consent allows it. */
  private record(name: string, properties: EventProperties, page?: PageContext): void {
    if (!this.parts.consent.allowed) {
      return;
    }
    // Checked here, as plain JavaScript can pass anything, and finding an invalid event
    // in a batch Kirora refused takes extra requests.
    if (typeof name !== 'string' || name === '' || !isObject(properties)) {
      this.parts.log('error', 'Not tracked: needs a name, and properties as an object');
      return;
    }
    let snapshot: EventProperties;
    try {
      // Copied now, so changing the object after track() doesn't change the event.
      snapshot = jsonSnapshot(properties) as EventProperties;
    } catch (error) {
      this.parts.log(
        'error',
        `${name} not tracked: its properties hold ${reason(error)}`,
      );
      return;
    }
    // Decided now: whoever signs in or out later, this event stays this user's.
    const owner = this.owner();
    page ??= pageContext();

    // First, as a new session's `Session Started` is queued ahead of this event.
    const session = this.continueSession(owner, page);
    this.capture(owner, name, snapshot, page, session);
  }

  /**
   * Records activity on `owner`'s session, tracking `Session Started` if one began, and
   * returns it; nothing if sessions are off or tracking isn't allowed.
   */
  private continueSession(
    owner: EventOwner,
    page?: PageContext,
  ): sessions.TouchedSession | undefined {
    if (!this.sessionsOn) {
      return undefined;
    }

    // Signed in again: activity is someone's.
    if (owner !== null) {
      this.signedOutHere = false;
    }
    const session = sessions.touchSession(this.sessionStore, owner, this.borrowing());
    if (session.started) {
      page ??= pageContext();
      const properties = sessionStartedProperties(page);
      this.capture(owner, sessions.SESSION_STARTED_EVENT, properties, page, session);
    }
    return session;
  }

  private safely(step: () => void): void {
    // An app's beforeSend that tracks would otherwise call itself without end.
    if (this.inBeforeSend) {
      this.parts.log('error', 'Not tracked: called from beforeSend');
      return;
    }
    try {
      step();
    } catch (error) {
      this.parts.log('error', 'Kirora failed', error);
    }
  }

  /** Whether activity here may continue another user's live session (see `Borrowing`). */
  private borrowing(): sessions.Borrowing {
    return { mayBorrow: !this.signedOutHere };
  }

  /** Sessions are on, and tracking is allowed. */
  private get sessionsOn(): boolean {
    return this.parts.trackSessions && this.parts.consent.allowed;
  }

  /**
   * Makes the event, passes it through `beforeSend`, and queues it as `owner`'s. Its time
   * is taken first, so a slow hook doesn't move it.
   */
  private capture(
    owner: EventOwner,
    name: string,
    properties: EventProperties,
    page: PageContext,
    session: sessions.TouchedSession | undefined,
  ): void {
    const occurredAt = eventTime().toISOString();

    const context: Record<string, unknown> = { ...page };
    if (session) {
      context.sessionId = session.sessionId;
    }
    context.device = { id: this.parts.deviceId() };

    const event = this.redacted({ name, properties, context });
    if (!event) {
      return;
    }

    this.enqueue(
      {
        idempotencyKey: uuid(),
        name,
        properties: event.properties,
        occurredAt,
        context: event.context,
      },
      owner,
      session?.borrowedFrom,
    );
  }

  /**
   * The event as `beforeSend` leaves it, or undefined if it drops it. Only a failure's
   * kind is logged, never the event: it may be what the hook was there to hide.
   */
  private redacted(event: BeforeSendEvent): BeforeSendEvent | undefined {
    const { beforeSend, log } = this.parts;
    if (!beforeSend) {
      return event;
    }

    let answer: unknown;
    this.inBeforeSend = true;
    try {
      // The properties are already this event's own copy; the context shares the page
      // with other events, so the hook gets a copy of its own.
      const context = jsonSnapshot(event.context) as Record<string, unknown>;
      answer = beforeSend({ ...event, context });
    } catch {
      log('error', `${event.name} not tracked: beforeSend threw`);
      return undefined;
    } finally {
      this.inBeforeSend = false;
    }

    return this.hookAnswer(event.name, answer);
  }

  /** The event `beforeSend` answered, as a copy; undefined, logged, for anything else. */
  private hookAnswer(name: string, answer: unknown): BeforeSendEvent | undefined {
    const { log } = this.parts;

    if (answer === null) {
      log('debug', `${name} dropped by beforeSend`);
      return undefined;
    }

    if (isThenable(answer)) {
      // Handled, so a rejection doesn't reach the page as unhandled.
      Promise.resolve(answer).catch(() => undefined);
      log('error', `${name} not tracked: beforeSend must answer at once, not later`);
      return undefined;
    }

    const notAnEvent = `${name} not tracked: beforeSend must answer an event or null`;
    if (!isObject(answer)) {
      log('error', notAnEvent);
      return undefined;
    }
    const { properties = {}, context = {} } = answer as Partial<BeforeSendEvent>;
    if (!isObject(properties) || !isObject(context)) {
      log('error', notAnEvent);
      return undefined;
    }

    try {
      return {
        name,
        properties: jsonSnapshot(properties) as EventProperties,
        context: jsonSnapshot(context) as Record<string, unknown>,
      };
    } catch (error) {
      log('error', `${name} not tracked: beforeSend answered ${reason(error)}`);
      return undefined;
    }
  }

  /**
   * Queues as `owner`, then lets delivery decide when to send. `sessionOwner`: the user
   * whose session an event tracked before sign-in continued.
   */
  private enqueue(event: QueuedEvent, owner: EventOwner, sessionOwner?: string): void {
    const { queue, delivery, log } = this.parts;
    queue.add(event, owner, sessionOwner).then(
      (waiting) => delivery.onEventQueued(waiting),
      (error: unknown) => log('error', `${event.name} not tracked`, error),
    );
  }
}

/** What made a value unsendable, without the value. */
function reason(error: unknown): string {
  return error instanceof NotJsonError ? error.message : 'something JSON has no form for';
}

/** A promise, or anything else `await` would wait for. */
function isThenable(value: unknown): boolean {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function';
}

/** A plain object: not null, an array, or something like a Date that JSON turns into a string. */
function isObject(value: unknown): boolean {
  return Object.prototype.toString.call(value) === '[object Object]';
}
