import { ClientApi } from './api/client-api.js';
import { KiroraApiError, UserTokenError } from './errors.js';
import { EventDelivery } from './events/event-delivery.js';
import { EventQueue } from './events/event-queue.js';
import { Identity, isUnnamedSubject } from './identity/identity.js';
import { WebPush } from './push/web-push.js';
import { deviceStorage, type KeyValueStorage } from './storage/device-storage.js';
import { siteStorage } from './storage/site-storage.js';
import { TrackingConsent } from './tracking/consent.js';
import { removeInstallationId, installationId } from './tracking/installation-id.js';
import { watchPageViews } from './tracking/page-context.js';
import { watchPageLifecycle } from './tracking/page-lifecycle.js';
import { SESSION_KEEPALIVE_MS } from './tracking/session.js';
import { Tracker } from './tracking/tracker.js';
import type { EventProperties, KiroraOptions, PushPermission } from './types.js';
import { logger, type Log } from './utils/log.js';

/** A signed-in tab sends within minutes, so its events never wait this long. */
const ORPHAN_EVENT_AGE_MS = 24 * 60 * 60_000;

/**
 * The Kirora browser client. Create one for the whole site. Nothing is sent until
 * `identify()`: events tracked before that wait on the device and go as the user who
 * signs in. A failing Kirora never throws from `track()` or breaks the page.
 */
export class Kirora {
  private readonly identity: Identity;
  private readonly api: ClientApi;
  private readonly log: Log;
  /** Shared across subdomains, so `www.` and `app.` see the same device and session. */
  private readonly siteStorage: KeyValueStorage;
  private readonly queue: EventQueue;
  private readonly delivery: EventDelivery;
  private readonly consent: TrackingConsent;
  private readonly tracker: Tracker;
  private readonly push: WebPush;
  private destroyed = false;
  /** Undoes what the constructor started: listeners and timers. */
  private readonly stopWatching: (() => void)[] = [];

  private readonly options: KiroraOptions;

  constructor(options: KiroraOptions) {
    // Plain JavaScript can pass anything, and a bad setting mustn't break the page.
    this.options = options =
      typeof options === 'object' && options ? options : ({} as KiroraOptions);
    this.log = logger(options.logLevel);
    if (
      typeof options.clientKey !== 'string' ||
      !options.clientKey.startsWith('kirora_pk_')
    ) {
      this.log('error', 'clientKey should be your client key, kirora_pk_…');
    }
    this.identity = new Identity(options.fetchUserToken);
    this.api = new ClientApi(options, this.identity);
    // Logged rather than thrown, so a bad setting can't break the page. Nothing is sent.
    if (this.api.urlProblem) this.log('error', this.api.urlProblem);
    const storage = deviceStorage((error) =>
      this.log(
        'error',
        "Can't save to localStorage; events will be lost on reload",
        error,
      ),
    );
    this.siteStorage = siteStorage(storage);
    this.queue = new EventQueue(storage, this.api.namespace);
    this.consent = new TrackingConsent(storage, options.requireTrackingConsent === true);
    this.delivery = new EventDelivery(
      this.api,
      this.identity,
      this.queue,
      this.consent,
      this.log,
    );
    this.tracker = new Tracker({
      identity: this.identity,
      queue: this.queue,
      delivery: this.delivery,
      consent: this.consent,
      siteStorage: this.siteStorage,
      trackSessions: options.trackSessions !== false,
      log: this.log,
    });
    this.push = new WebPush(
      this.api,
      this.identity,
      storage,
      options.push === true ? {} : options.push,
      () => installationId(this.siteStorage),
      this.log,
    );
    // What's stored from before the visitor refused, e.g. before consent was required.
    if (this.consent.refused) this.forgetTracking();
    // Server rendering: nothing to watch, and nothing happens until identify().
    if (typeof document === 'undefined') return;
    // Loading the page counts as activity, so it can start a session.
    this.tracker.noteActivity();
    if (options.trackPageViews) {
      this.stopWatching.push(watchPageViews(() => this.trackPageView()));
    }
    // Hiding is the last chance to send before the tab closes; back online, there's no
    // need to wait out our backoff.
    const sendNow = () => void this.delivery.flush();
    this.stopWatching.push(
      watchPageLifecycle(
        {
          onHidden: sendNow,
          onOnline: sendNow,
          // Returning is activity, and time on a visible page never ends a visit.
          onReturn: () => this.tracker.noteActivity(),
          whileVisible: () => this.tracker.keepSessionAlive(),
        },
        SESSION_KEEPALIVE_MS,
      ),
    );
  }

  /**
   * Sets the signed-in user and starts sending their queued events. Call it on every
   * page load where they're signed in. Without a token, it asks `fetchUserToken` for one.
   * If identify() is called again before a token arrives, the latest call wins. Throws
   * only for the token; push registration errors are logged.
   */
  async identify(userToken?: string): Promise<void> {
    if (!this.destroyed) await this.identity.signIn(userToken, () => this.onSignedIn());
  }

  /**
   * Call before your own sign-out. Tries to send queued events, detaches this browser
   * from the user's pushes, then forgets the user and anything still unsent. If Kirora
   * can't be told, the browser's push subscription is cancelled instead; it only throws
   * if that fails too, and the user is forgotten either way.
   */
  async logout(): Promise<void> {
    if (this.destroyed) return;
    // Otherwise its push registration could land after the unregister.
    await this.identity.settled();
    const { user } = this.identity;
    if (!user) return;
    await this.delivery.flush();
    try {
      await this.push.unregister(user);
    } finally {
      // Anything left belongs to this user, so don't send it as the next one. Events from
      // before sign-in go too, unless the next user is already signed in to send them;
      // and if that's this user again, nothing of theirs goes.
      if (this.identity.signOut(user)) await this.queue.clear(user.subject);
      else if (this.identity.user?.subject !== user.subject) {
        await this.queue.clearOwnedBy((owner) => owner === user.subject);
      }
      // Kept past a consent withdrawal only so this browser could be detached.
      if (this.consent.refused) this.forgetDeviceIdIfUnused();
    }
  }

  /**
   * Tracks an event, with a copy of `properties` as they are now. Events Kirora rejects
   * are logged; the rest still go through.
   */
  track(name: string, properties: EventProperties = {}): void {
    if (!this.destroyed) this.tracker.track(name, properties);
  }

  /** Tracks `Page Viewed`, for calling from your router instead of `trackPageViews`. */
  trackPageView(): void {
    if (!this.destroyed) this.tracker.trackPageView();
  }

  /**
   * For `requireTrackingConsent`. Withdrawing consent also clears queued events, the
   * session, and the device id unless a push registration still needs it to detach.
   */
  setTrackingConsent(granted: boolean): void {
    const newlyAllowed = this.consent.answer(granted);
    if (!granted) this.forgetTracking();
    if (!newlyAllowed || this.destroyed) return;
    // Catch up on the session and page view we skipped while waiting for consent, and
    // send what waited for it.
    this.tracker.noteActivity();
    if (this.options.trackPageViews) this.trackPageView();
    void this.delivery.flush();
  }

  /** Shows the notification prompt. Call it from a click; browsers block it otherwise. */
  requestPushPermission(): Promise<PushPermission> {
    return this.push.requestPermission();
  }

  /** Records consent to marketing pushes. Browser permission alone doesn't count. */
  async setPushConsent(granted: boolean): Promise<void> {
    await this.identity.settled();
    if (this.destroyed) return;
    await this.api.request('PUT', '/push-consent', { body: { granted } });
  }

  /**
   * Sends queued events now. Resolving doesn't mean all were accepted: after a network
   * or server failure they wait for a retry.
   */
  flush(): Promise<void> {
    return this.delivery.flush();
  }

  /**
   * Stops this client's timers and listeners at once, without sending or deleting
   * anything: for hot reload, tests, or replacing the client. A destroyed client tracks
   * and sends nothing; events still waiting stay on the device for the next client.
   */
  destroy(): void {
    this.destroyed = true;
    // Forgetting the user stops work already under way for them, such as a sign-in
    // waiting for its token or a push registration, at its next step.
    this.identity.end();
    this.delivery.destroy();
    for (const stop of this.stopWatching.splice(0)) stop();
  }

  /** Forgets what tracking stored, as when the visitor refuses it. */
  private forgetTracking(): void {
    this.tracker.forget();
    this.forgetDeviceIdIfUnused();
  }

  /** The device id is also the installation id, so a push registration still needs it. */
  private forgetDeviceIdIfUnused(): void {
    if (!this.push.registered) removeInstallationId(this.siteStorage);
  }

  /** Once signed in: send what waits, and register this browser for push. */
  private async onSignedIn(): Promise<void> {
    const { user } = this.identity;
    // Events left by earlier sign-ins with tokens naming no one: they'd otherwise wait
    // for good, crowding out the events that can go. Only once they're old, as another
    // tab may still be signed in to send them.
    const staleBefore = Date.now() - ORPHAN_EVENT_AGE_MS;
    void this.queue
      .clearOwnedBy(
        (owner, event) =>
          owner !== user?.subject &&
          isUnnamedSubject(owner) &&
          Date.parse(event.occurredAt) < staleBefore,
      )
      .catch((error: unknown) => this.log('error', "Couldn't clear old events", error));
    void this.delivery.flush();
    try {
      await this.push.register();
    } catch (error) {
      const tokenRefused = error instanceof KiroraApiError && error.status === 401;
      if (tokenRefused || error instanceof UserTokenError) throw error;
      this.log('error', 'Push registration failed', error);
    }
  }
}
