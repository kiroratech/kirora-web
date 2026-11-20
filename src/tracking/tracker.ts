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
import {
  endSession,
  keepSessionAlive,
  SESSION_STARTED_EVENT,
  touchSession,
  type SessionStore,
} from './session.js';

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

  constructor(private readonly parts: TrackerDependencies) {}

  /** Builds the event right away so its time and page are accurate, then queues it. */
  track(name: string, properties: EventProperties): void {
    this.safely(() => this.record(name, properties));
  }

  /** Tracks `Page Viewed`, with the page copied into properties so segments can filter on it. */
  trackPageView(): void {
    this.safely(() => {
      if (!this.parts.consent.allowed) return;
      const page = pageContext();
      this.record(PAGE_VIEWED_EVENT, { ...page.page }, page);
    });
  }

  /** Activity keeps the session alive, or starts a new one with `Session Started`. */
  noteActivity(): void {
    this.safely(() => this.touchSession(this.owner()));
  }

  /** Extends the current session without starting one, e.g. while the page is visible. */
  keepSessionAlive(): void {
    this.safely(() => {
      if (this.sessionsOn) keepSessionAlive(this.sessionStore);
    });
  }

  /** Ends the session, so the next activity starts another: for a sign-out. */
  endSession(): void {
    this.safely(() => endSession(this.sessionStore));
  }

  /** Forgets queued events and the session, as when consent is withdrawn. */
  forget(): void {
    this.parts.queue
      .clearAll()
      .catch((error: unknown) => this.parts.log('error', "Couldn't clear events", error));
    this.endSession();
  }

  private get sessionStore(): SessionStore {
    return { storage: this.parts.siteStorage, key: this.parts.sessionKey };
  }

  /** Who owns what's tracked now: no one while logout() signs the user out. */
  private owner(): EventOwner {
    return this.parts.identity.owner?.subject ?? null;
  }

  /** The page is only looked at once consent allows it. */
  private record(name: string, properties: EventProperties, page?: PageContext): void {
    if (!this.parts.consent.allowed) return;
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
    const sessionId = this.touchSession(owner, page);
    this.capture(owner, name, snapshot, page, sessionId);
  }

  /** Returns the session id, if sessions are on and tracking is allowed. */
  private touchSession(owner: EventOwner, page?: PageContext): string | undefined {
    if (!this.sessionsOn) return undefined;
    const { sessionId, started } = touchSession(this.sessionStore, owner);
    if (started) {
      page ??= pageContext();
      this.capture(
        owner,
        SESSION_STARTED_EVENT,
        sessionStartedProperties(page),
        page,
        sessionId,
      );
    }
    return sessionId;
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
    sessionId: string | undefined,
  ): void {
    const occurredAt = eventTime().toISOString();
    const event = this.redacted({
      name,
      properties,
      context: {
        ...page,
        ...(sessionId ? { sessionId } : {}),
        device: {
          id: this.parts.deviceId(),
        },
      },
    });
    if (!event) return;
    this.enqueue(
      {
        idempotencyKey: uuid(),
        name,
        properties: event.properties,
        occurredAt,
        context: event.context,
      },
      owner,
    );
  }

  /**
   * The event as `beforeSend` leaves it, or undefined if it drops it. Only a failure's
   * kind is logged, never the event: it may be what the hook was there to hide.
   */
  private redacted(event: BeforeSendEvent): BeforeSendEvent | undefined {
    const { beforeSend, log } = this.parts;
    if (!beforeSend) return event;
    let answer: unknown;
    this.inBeforeSend = true;
    try {
      // The properties are already this event's own copy; the context shares the page
      // with other events, so the hook gets a copy of its own.
      answer = beforeSend({
        ...event,
        context: jsonSnapshot(event.context) as Record<string, unknown>,
      });
    } catch {
      log('error', `${event.name} not tracked: beforeSend threw`);
      return undefined;
    } finally {
      this.inBeforeSend = false;
    }
    if (answer === null) {
      log('debug', `${event.name} dropped by beforeSend`);
      return undefined;
    }
    if (typeof (answer as PromiseLike<unknown> | undefined)?.then === 'function') {
      // Handled, so a rejection doesn't reach the page as unhandled.
      Promise.resolve(answer).catch(() => undefined);
      log(
        'error',
        `${event.name} not tracked: beforeSend must answer at once, not later`,
      );
      return undefined;
    }
    const { properties = {}, context = {} } = isObject(answer)
      ? (answer as Partial<BeforeSendEvent>)
      : {};
    if (!isObject(answer) || !isObject(properties) || !isObject(context)) {
      log('error', `${event.name} not tracked: beforeSend must answer an event or null`);
      return undefined;
    }
    try {
      return {
        name: event.name,
        properties: jsonSnapshot(properties) as EventProperties,
        context: jsonSnapshot(context) as Record<string, unknown>,
      };
    } catch (error) {
      log('error', `${event.name} not tracked: beforeSend answered ${reason(error)}`);
      return undefined;
    }
  }

  /** Queues as `owner`, then lets delivery decide when to send. */
  private enqueue(event: QueuedEvent, owner: EventOwner): void {
    const { queue, delivery, log } = this.parts;
    queue.add(event, owner).then(
      (waiting) => delivery.onEventQueued(waiting),
      (error: unknown) => log('error', `${event.name} not tracked`, error),
    );
  }
}

/** What made a value unsendable, without the value. */
function reason(error: unknown): string {
  return error instanceof NotJsonError ? error.message : 'something JSON has no form for';
}

/** A plain object: not null, an array, or something like a Date that JSON turns into a string. */
function isObject(value: unknown): boolean {
  return Object.prototype.toString.call(value) === '[object Object]';
}
