import type { EventDelivery } from '../events/event-delivery.js';
import type { EventQueue, QueuedEvent } from '../events/event-queue.js';
import type { Identity } from '../identity/identity.js';
import type { KeyValueStorage } from '../storage/device-storage.js';
import type { EventProperties } from '../types.js';
import type { Log } from '../utils/log.js';
import { uuid } from '../utils/uuid.js';
import type { TrackingConsent } from './consent.js';
import { installationId } from './installation-id.js';
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
} from './session.js';

/** Only what the tracker uses of each part, so it depends on no more. */
type TrackerDependencies = {
  identity: Pick<Identity, 'user'>;
  queue: Pick<EventQueue, 'add' | 'clearAll'>;
  delivery: Pick<EventDelivery, 'onEventQueued'>;
  consent: Pick<TrackingConsent, 'allowed'>;
  /** Shared across subdomains, so `www.` and `app.` see the same device and session. */
  siteStorage: KeyValueStorage;
  trackSessions: boolean;
  log: Log;
};

/**
 * Turns what the app tracks into queued events: their time, page, session and device,
 * owned by whoever is signed in. Nothing is recorded without tracking consent, and
 * nothing here throws: a failure is logged, so it never breaks the host page.
 */
export class Tracker {
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
    this.safely(() => this.touchSession());
  }

  /** Extends the current session without starting one, e.g. while the page is visible. */
  keepSessionAlive(): void {
    this.safely(() => {
      if (this.sessionsOn) keepSessionAlive(this.parts.siteStorage);
    });
  }

  /** Forgets queued events and the session, as when consent is withdrawn. */
  forget(): void {
    void this.parts.queue.clearAll();
    endSession(this.parts.siteStorage);
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
      snapshot = JSON.parse(JSON.stringify(properties)) as EventProperties;
    } catch (error) {
      this.parts.log('error', `${name} not tracked: its properties aren't JSON`, error);
      return;
    }
    page ??= pageContext();
    const sessionId = this.touchSession(page);
    this.enqueue(this.event(name, snapshot, page, sessionId));
  }

  /** Returns the session id, if sessions are on and tracking is allowed. */
  private touchSession(page?: PageContext): string | undefined {
    if (!this.sessionsOn) return undefined;
    const { sessionId, started } = touchSession(this.parts.siteStorage);
    if (started) {
      page ??= pageContext();
      this.enqueue(
        this.event(
          SESSION_STARTED_EVENT,
          sessionStartedProperties(page),
          page,
          sessionId,
        ),
      );
    }
    return sessionId;
  }

  private safely(step: () => void): void {
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

  /** Queues as the current user (if any), then lets delivery decide when to send. */
  private enqueue(event: QueuedEvent): void {
    const { queue, identity, delivery, log } = this.parts;
    queue.add(event, identity.user?.subject ?? null).then(
      (waiting) => delivery.onEventQueued(waiting),
      (error: unknown) => log('error', `${event.name} not tracked`, error),
    );
  }

  /** `device.id` will let us link activity from before sign-in to the user later. */
  private event(
    name: string,
    properties: EventProperties,
    page: PageContext,
    sessionId: string | undefined,
  ): QueuedEvent {
    return {
      idempotencyKey: uuid(),
      name,
      properties,
      occurredAt: eventTime().toISOString(),
      context: {
        ...page,
        ...(sessionId ? { sessionId } : {}),
        device: { id: installationId(this.parts.siteStorage) },
      },
    };
  }
}

/** A plain object: not null, an array, or something like a Date that JSON turns into a string. */
function isObject(value: unknown): boolean {
  return Object.prototype.toString.call(value) === '[object Object]';
}
