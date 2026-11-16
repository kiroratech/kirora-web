import { ClientApi } from './api/client-api.js';
import { KiroraApiError, KiroraError, UserTokenError } from './errors.js';
import { EventDelivery } from './events/event-delivery.js';
import { EventQueue } from './events/event-queue.js';
import { Identity, isUnnamedSubject, type SignedInUser } from './identity/identity.js';
import { WebPush } from './push/web-push.js';
import { deviceStorage, type KeyValueStorage } from './storage/device-storage.js';
import { STORAGE_KEYS } from './storage/keys.js';
import { siteStorage } from './storage/site-storage.js';
import { TrackingConsent } from './tracking/consent.js';
import { installationId } from './tracking/installation-id.js';
import { watchPageViews } from './tracking/page-context.js';
import { watchPageLifecycle } from './tracking/page-lifecycle.js';
import { SESSION_KEEPALIVE_MS } from './tracking/session.js';
import { Tracker } from './tracking/tracker.js';
import type {
  EventProperties,
  KiroraOptions,
  PushPermission,
  PushStatus,
} from './types.js';
import { logger, type Log } from './utils/log.js';
import { settledBy } from './utils/timeout.js';

/** A signed-in tab sends within minutes, so its events never wait this long. */
const ORPHAN_EVENT_AGE_MS = 24 * 60 * 60_000;
/** logout() returns within this, whatever the network or the app's token route does. */
const LOGOUT_DEADLINE_MS = 5_000;

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
  /** Where `device.id` is kept, per workspace. */
  private readonly installationIdKey: string;
  /**
   * The events the latest sign-in adopted, until Kirora accepts its token. Refused before
   * then, the sign-in failed, so it gives them back.
   */
  private adoption: { user: SignedInUser; keys: Set<string> } | undefined;
  private destroyed = false;
  /** Undoes what the constructor started: listeners and timers. */
  private readonly stopWatching: (() => void)[] = [];

  constructor(options: KiroraOptions) {
    // Plain JavaScript can pass anything, and a bad setting mustn't break the page.
    options = typeof options === 'object' && options ? options : ({} as KiroraOptions);
    this.log = logger(options.logLevel);
    if (
      typeof options.clientKey !== 'string' ||
      !options.clientKey.startsWith('kirora_pk_')
    ) {
      this.log('error', 'clientKey should be your client key, kirora_pk_…');
    }
    this.identity = new Identity(options.fetchUserToken);
    this.api = new ClientApi(options, this.identity, (user) => this.onTokenRefused(user));
    // Logged rather than thrown, so a bad setting can't break the page. Nothing is sent.
    if (this.api.urlProblem) this.log('error', this.api.urlProblem);
    const storage = deviceStorage((error) =>
      this.log(
        'error',
        "Can't save to localStorage: events are lost on reload, and saved tracking " +
          'consent needs setTrackingConsent(true) again',
        error,
      ),
    );
    this.siteStorage = siteStorage(storage);
    const { namespace } = this.api;
    this.installationIdKey = STORAGE_KEYS.installationId(namespace);
    this.queue = new EventQueue(storage, namespace);
    this.consent = new TrackingConsent(
      storage,
      namespace,
      options.requireTrackingConsent === true,
      this.log,
    );
    if (!storage.readable) {
      this.log(
        'error',
        "Can't read localStorage, so a refusal saved there can't be seen: nothing is " +
          'tracked until setTrackingConsent(true)',
      );
    }
    this.delivery = new EventDelivery(
      this.api,
      this.identity,
      this.queue,
      this.consent,
      this.log,
    );
    const deviceId = () => installationId(this.siteStorage, this.installationIdKey);
    this.tracker = new Tracker({
      identity: this.identity,
      queue: this.queue,
      delivery: this.delivery,
      consent: this.consent,
      siteStorage: this.siteStorage,
      sessionKey: STORAGE_KEYS.session(namespace),
      deviceId,
      trackSessions: options.trackSessions !== false,
      beforeSend:
        typeof options.beforeSend === 'function' ? options.beforeSend : undefined,
      log: this.log,
    });
    this.push = new WebPush(
      this.api,
      this.identity,
      storage,
      options.push === true ? {} : options.push,
      deviceId,
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
          // Also the time to send an event too large to go while the page was hidden.
          onReturn: () => {
            this.tracker.noteActivity();
            sendNow();
          },
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
    if (this.destroyed) return;
    await this.identity.signIn(userTokenOf(userToken), () => this.onSignedIn());
  }

  /**
   * Call before your own sign-out. Tries to send the user's queued events and to detach
   * this browser from their pushes, within 5 seconds, then forgets the user and anything
   * of theirs still unsent. Never rejects. If Kirora can't be told, the browser's push
   * subscription is cancelled, and the detachment is retried in the background while the
   * page stays open.
   */
  async logout(): Promise<void> {
    if (this.destroyed) return;
    const deadline = Date.now() + LOGOUT_DEADLINE_MS;
    // Who this logout is for is decided by what came before it, never by an identify()
    // called after it.
    const signInsBefore = this.identity.generation;
    const signedInBefore = this.identity.user;
    // Otherwise its push registration could land after the detachment. A sign-in still
    // waiting for its token at the deadline is abandoned, as this logout came after it,
    // unless a newer sign-in has started since.
    const settled = await settledBy(this.identity.settled(), deadline);
    const signedInSince = this.identity.generation !== signInsBefore;
    if (!settled && !signedInSince) this.identity.abandonSignIn();
    // The user a sign-in under way when logout() was called set, or failing that whoever
    // was signed in then. A sign-in started since is newer, so it stays.
    const user = signedInSince ? signedInBefore : this.identity.user;
    if (!user) return;
    try {
      if (!(await settledBy(this.delivery.flush(), deadline))) {
        this.log(
          'error',
          "Gave up waiting for Kirora; the user's unsent events are dropped",
        );
      }
      // Carries on in the background if it fails or isn't done by the deadline.
      await settledBy(this.push.detach(user, deadline), deadline);
      const signedOut = this.identity.signOut(user);
      // Anything left is this user's, so it never goes as the next one; but if they
      // signed in again meanwhile, it's theirs to send.
      if (this.identity.user?.subject !== user.subject) {
        await this.queue.clearOwnedBy((owner) => owner === user.subject);
      }
      if (signedOut) this.tracker.endSession();
      // Kept past a consent withdrawal only so this browser could be detached.
      if (this.consent.refused) this.forgetDeviceIdIfUnused();
    } catch (error) {
      this.log('error', 'Logout failed to clean up', error);
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
    const newlyAllowed = this.consent.answer(granted === true);
    if (granted !== true) {
      this.delivery.cancel();
      this.forgetTracking();
    }
    if (!newlyAllowed || this.destroyed) return;
    // Tracking starts from now: this is activity, but nothing skipped before is made up.
    this.tracker.noteActivity();
    void this.delivery.flush();
  }

  /** Shows the notification prompt. Call it from a click; browsers block it otherwise. */
  requestPushPermission(): Promise<PushPermission> {
    return this.push.requestPermission();
  }

  /**
   * This browser's push, for a "notifications on/off" setting: `enabled`, `disabled`, or
   * the permission (`denied`, `unanswered`, `unsupported`). Never prompts; waits for a
   * sign-in under way.
   */
  async getPushStatus(): Promise<PushStatus> {
    await this.identity.settled();
    return this.push.status();
  }

  /**
   * This browser's own push on/off, kept on the device for whoever signs in, as opposed
   * to marketing consent. Off detaches the browser and cancels its subscription; on
   * registers it again if permission is already granted, never prompting. Never rejects.
   */
  async setPushEnabled(enabled: boolean): Promise<void> {
    if (this.destroyed) return;
    await this.identity.settled();
    try {
      await this.push.setEnabled(enabled === true);
    } catch (error) {
      this.log('error', `Couldn't turn push ${enabled === true ? 'on' : 'off'}`, error);
    }
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
    this.push.destroy();
    for (const stop of this.stopWatching.splice(0)) stop();
  }

  /** A sign-in whose token Kirora never accepted gives back the events it adopted. */
  private onTokenRefused(user: SignedInUser): void {
    const { adoption } = this;
    if (adoption?.user !== user || user.confirmed) return;
    this.adoption = undefined;
    this.queue
      .release(user.subject, adoption.keys)
      .catch((error: unknown) => this.log('error', "Couldn't release events", error));
  }

  /** Forgets what tracking stored, as when the visitor refuses it. */
  private forgetTracking(): void {
    this.tracker.forget();
    this.forgetDeviceIdIfUnused();
  }

  /** The device id is also the installation id, so a push registration still needs it. */
  private forgetDeviceIdIfUnused(): void {
    if (!this.push.registered) {
      this.siteStorage.removeItem(this.installationIdKey);
    }
  }

  /** Once signed in: adopt and send what waits, and register this browser for push. */
  private async onSignedIn(): Promise<void> {
    const { user } = this.identity;
    // What was tracked before sign-in is this user's from now on, whoever signs in next,
    // unless Kirora refuses their token before accepting it once.
    if (user) {
      try {
        const keys = await this.queue.adopt(user.subject);
        this.adoption = keys.size > 0 && !user.confirmed ? { user, keys } : undefined;
      } catch (error) {
        this.log('error', "Couldn't adopt events", error);
      }
    }
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

/**
 * The token `identify()` was given, or undefined for none. Plain JavaScript can pass
 * anything, e.g. the user instead of their token, which Kirora would refuse without
 * saying why; that's refused here instead.
 */
function userTokenOf(argument: unknown): string | undefined {
  if (argument === undefined || argument === null) return undefined;
  if (typeof argument === 'string' && argument !== '') return argument;
  throw new KiroraError(
    'identify() takes a user token, or nothing to use fetchUserToken',
  );
}
