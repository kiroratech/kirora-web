import { signedInElsewhere } from '../identity/signed-in-elsewhere.js';
import type { NotificationTaps } from './notification-taps.js';
import { SDK_NAME, type ClientApi } from '../api/client-api.js';
import type { Identity, SignedInUser } from '../identity/identity.js';
import {
  isSettledRefusal,
  isTokenRefusal,
  KiroraApiError,
  KiroraError,
  retryAfterOf,
} from '../errors.js';
import { readJson, type KeyValueStorage } from '../storage/device-storage.js';
import { STORAGE_KEYS } from '../storage/keys.js';
import { localeAndTimezone } from '../tracking/page-context.js';
import { base64UrlBytes } from '../utils/base64url.js';
import { withTimeout } from '../utils/timeout.js';
import {
  forgetSubscription,
  readSubscription,
  saveSubscription,
  type SavedSubscription,
} from './subscription-store.js';
import type { KiroraPushOptions, PushPermission, PushStatus } from '../types.js';
import type { Log } from '../utils/log.js';

/** How long the worker's IndexedDB record is waited for, before registering without it. */
const WORKER_RECORD_TIMEOUT_MS = 2000;

/** Response of `GET /push-app`. */
type PushApp = { pushAppId: string; name: string; vapidPublicKey: string };

/**
 * Saved after registering, to skip repeat registrations. `config` says what it was made
 * for, so a change of workspace, push app or installation registers again.
 */
type PushRegistration = {
  userSubject: string | null;
  config: string;
  endpoint: string;
  /** What the subscription was made with, for browsers that can't say. */
  vapidPublicKey?: string;
  at: number;
  /** Kirora's, from its answer: a denial names it. Missing from older records. */
  pushAppId?: string;
  lastSeenAt?: string;
  /**
   * Kirora's, from its answer: detaches this registration with nobody signed in (a reload
   * where the app restored its own session, or a retry after one). Missing from older
   * records.
   */
  deviceSecret?: string;
  /** Set once Kirora was told permission is denied. */
  denied?: true;
};

/** What Kirora answers to `PUT /devices/{id}`. */
type DeviceAnswer = { lastSeenAt?: string; deviceSecret?: string } | undefined;

/** A detachment still being retried, kept so a reload carries on with it. */
type PendingDetach = {
  installationId: string;
  lastSeenAt?: string;
  deviceSecret: string;
  /** No retry after this (epoch ms): a day from the sign-out. */
  giveUpAt: number;
};

/**
 * Detaching a signed-out user's browser, retried in the background until it's done. The
 * user's token is kept in memory only.
 */
type Cleanup = {
  /**
   * The signed-out user, whose token detaches the browser while Kirora accepts it. Once
   * it's refused, or with nobody signed in, it's undefined and the device secret does.
   */
  user?: SignedInUser;
  installationId: string;
  /** Detaches the registration without a user's token. */
  deviceSecret?: string;
  /**
   * When Kirora last registered the browser for the user, if known: Kirora then detaches
   * only registrations up to then, so a late retry can't undo a newer one.
   */
  lastSeenAt: string | undefined;
  /**
   * Whether a registration is on record. Only then is the browser's subscription surely
   * Kirora's, to cancel if detaching fails: without one, it may be the site's own.
   */
  registered: boolean;
  /** How long the next failure waits before trying again. */
  retryDelayMs: number;
  /** No retry after this (epoch ms). */
  giveUpAt: number;
};

const DEFAULT_SERVICE_WORKER_URL = '/kirora-sw.js';
const WORKER_ACTIVATION_TIMEOUT_MS = 30_000;
/** Re-register at most daily for the same user, configuration and subscription. */
const REGISTRATION_REFRESH_MS = 24 * 60 * 60_000;
/** A failed detachment is retried after this, doubling up to the maximum, for a day. */
const FIRST_CLEANUP_RETRY_MS = 30_000;
const MAX_CLEANUP_RETRY_MS = 5 * 60_000;
const CLEANUP_GIVE_UP_MS = 24 * 60 * 60_000;
/** What a detachment by a deadline leaves of it to cancel the subscription if it fails. */
const CANCEL_TIME_MS = 1_000;

/**
 * Permission prompt, push subscription and device registration. `options` is undefined
 * when push is off, but `detach()` still cleans up an old registration.
 */
export class WebPush {
  /** Per workspace, so it never vouches for another workspace's registration. */
  private readonly registrationKey: string;
  /** Where a detachment still being retried is kept, for a reload to carry on with. */
  private readonly pendingDetachKey: string;
  /** Set while `setPushEnabled(false)` holds. */
  private readonly disabledKey: string;
  private readonly serviceWorkerUrl: string;
  /** The registration or detachment running now, if any. Never rejects. */
  private operations: Promise<void> = Promise.resolve();
  /** Detachments waiting to be retried, kept in memory only. */
  private readonly retries = new Set<ReturnType<typeof setTimeout>>();
  private destroyed = false;
  /** The user whose latest registration failed, so it can't be counted as registered. */
  private failedFor: SignedInUser | undefined;

  constructor(
    private readonly api: ClientApi,
    private readonly identity: Identity,
    private readonly storage: KeyValueStorage,
    private readonly options: KiroraPushOptions | undefined,
    private readonly installationId: () => string,
    private readonly log: Log,
  ) {
    this.registrationKey = STORAGE_KEYS.pushRegistration(api.namespace);
    this.disabledKey = STORAGE_KEYS.pushDisabled(api.namespace);
    this.pendingDetachKey = STORAGE_KEYS.pushPendingDetach(api.namespace);
    this.serviceWorkerUrl = options?.serviceWorkerUrl ?? DEFAULT_SERVICE_WORKER_URL;
  }

  async requestPermission(): Promise<PushPermission> {
    if (!this.options || !webPushSupported()) {
      return 'unsupported';
    }
    const permission = await Notification.requestPermission();

    // The prompt was dismissed: nothing to tell Kirora.
    if (permission === 'default') {
      return 'unanswered';
    }

    // Saying yes to the prompt is turning push on.
    if (permission === 'granted') {
      this.storage.removeItem(this.disabledKey);
    }

    // Registered, or a denial reported. A failure doesn't change the answer:
    // getPushStatus() says whether this browser is registered.
    try {
      await this.register();
    } catch (error) {
      const what =
        permission === 'granted'
          ? 'register this browser for push'
          : 'tell Kirora notifications are blocked';
      this.log('error', `Couldn't ${what}`, error);
    }
    return permission;
  }

  /**
   * Registers this browser for push as the user signed in now, if permission is granted,
   * or tells Kirora it's denied.
   * Gives up as soon as someone else signs in (or nobody is), so an earlier user's
   * registration never lands after a later one's.
   */
  register(): Promise<void> {
    // Captured now: the registration is for this user, or nobody.
    const { user } = this.identity;
    if (!user) {
      return Promise.resolve();
    }
    return this.oneAtATime(async () => {
      try {
        await this.registerAs(user);
        if (this.failedFor === user) {
          this.failedFor = undefined;
        }
      } catch (error) {
        this.failedFor = user;
        throw error;
      }
    });
  }

  /**
   * Hands taps on Kirora pushes to `taps`, where push is on, whenever permission is
   * granted. Returns a function that stops, or undefined if there's nothing to watch.
   */
  watchTaps(taps: NotificationTaps): (() => void) | undefined {
    if (!this.options || !webPushSupported()) {
      return undefined;
    }
    // A tap that opened this page can only have come with permission granted.
    return taps.watch(this.serviceWorkerUrl, Notification.permission === 'granted');
  }

  /**
   * This browser's push, without prompting: the permission, then whether it's registered
   * for the user signed in now. Waits for a registration under way.
   */
  async status(): Promise<PushStatus> {
    if (!this.options || !webPushSupported()) {
      return 'unsupported';
    }
    if (Notification.permission === 'denied') {
      return 'denied';
    }
    if (Notification.permission !== 'granted') {
      return 'unanswered';
    }
    await this.operations;
    const { user } = this.identity;
    const registered =
      user !== null &&
      this.failedFor !== user &&
      !this.disabled &&
      this.registeredFor(user.subject, this.config(this.options)) !== undefined;
    if (!registered) {
      return 'disabled';
    }
    // The browser may have dropped its subscription since. One the worker replaced (and
    // told Kirora about) has a new endpoint, so any subscription counts.
    const subscription = await currentSubscription(this.serviceWorkerUrl).catch(
      () => undefined,
    );
    return subscription ? 'enabled' : 'disabled';
  }

  /**
   * The browser's own push choice, kept on the device for whoever signs in. Off detaches
   * it from the user signed in now (retried as logout's is) and cancels the browser's
   * subscription; on registers it again if permission is granted, never prompting.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      this.storage.removeItem(this.disabledKey);
      await this.register();
      return;
    }
    this.storage.setItem(this.disabledKey, '1');
    // As for a detachment: only a subscription Kirora has on record is surely its own.
    // Read in turn, after any registration still under way.
    const ours = await this.operations.then(() => this.registered);
    // With nobody signed in, the device secret detaches it.
    const { user } = this.identity;
    if (user) {
      await this.detach(user);
    } else {
      await this.detachBySecret();
    }
    if (ours) {
      await this.oneAtATime(() => this.cancelSubscription());
    }
  }

  private get disabled(): boolean {
    return this.storage.getItem(this.disabledKey) !== null;
  }

  /** Whether Kirora has this browser on record as registered, as far as it knows. */
  get registered(): boolean {
    return this.storage.getItem(this.registrationKey) !== null;
  }

  private async registerAs(user: SignedInUser): Promise<void> {
    const { options } = this;
    const current = () => this.identity.user === user;
    if (!options || !current() || !webPushSupported() || this.disabled) {
      return;
    }
    const config = this.config(options);
    if (Notification.permission === 'denied') {
      return this.reportDenied(user, config);
    }
    if (Notification.permission !== 'granted') {
      return;
    }
    if ((await this.registrationIsFresh(user.subject, config)) || !current()) {
      return;
    }
    // Independent, so done together: which app to use, and a worker ready to subscribe.
    const [pushApp, worker] = await Promise.all([
      this.choosePushApp(user, options.pushAppId),
      readyRegistration(this.serviceWorkerUrl),
    ]);
    if (!pushApp || !current()) {
      return;
    }
    // The worker's record outlives a logout's: proof a subscription is ours after it.
    const workerRecord = await this.readWorkerRecord(worker.scope);
    const subscription = await pushSubscription(
      worker,
      pushApp.vapidPublicKey,
      this.lastRegistration(),
      workerRecord,
    );
    if (!current()) {
      return;
    }

    // Saved before Kirora answers, so it's known as ours even if that fails.
    await this.saveWorkerRecord(worker.scope, pushApp, subscription);
    // Again: the user may have changed while that was saved.
    if (!current()) {
      return;
    }

    const answer = await this.putDevice(user, {
      pushAppId: pushApp.pushAppId,
      targetKind: 'web_push_subscription',
      permission: 'granted',
      subscription,
    });

    // Saved even if the user changed meanwhile: it records who Kirora now has, so the
    // next user's registration (queued behind this one) isn't skipped as fresh.
    const registration: PushRegistration = {
      userSubject: user.subject,
      config,
      endpoint: subscription.endpoint!,
      vapidPublicKey: pushApp.vapidPublicKey,
      at: Date.now(),
      pushAppId: pushApp.pushAppId,
      lastSeenAt: answer?.lastSeenAt,
      deviceSecret: answer?.deviceSecret,
    };
    this.storage.setItem(this.registrationKey, JSON.stringify(registration));
    this.log('debug', `Registered this browser with ${pushApp.name}`);
  }

  /**
   * `PUT /devices/<installation id>` as `user`, with the browser's language and time zone
   * for push reports. No app or OS version: Kirora reads the user agent.
   */
  private putDevice(
    user: SignedInUser,
    body: Record<string, unknown>,
  ): Promise<DeviceAnswer | undefined> {
    return this.api.request<DeviceAnswer>('PUT', `/devices/${this.installationId()}`, {
      as: user,
      body: { ...body, ...localeAndTimezone() },
    });
  }

  /**
   * The worker's record of the subscription, if this workspace saved it: two on one site
   * share the worker, and another's record says nothing about whose a subscription is.
   * Bounded, as IndexedDB may never answer (Safari 14): registering doesn't need it.
   */
  private async readWorkerRecord(scope: string): Promise<SavedSubscription | undefined> {
    let record: SavedSubscription | undefined;
    try {
      record = await withTimeout(readSubscription(scope), WORKER_RECORD_TIMEOUT_MS);
    } catch {
      return undefined;
    }

    const ours =
      record?.clientKey === this.api.clientKey && record.apiUrl === this.api.apiUrl;
    return ours ? record : undefined;
  }

  /**
   * Keeps the subscription for the worker, so it can tell Kirora when the browser
   * replaces it. Bounded and best effort, as reading it is.
   */
  private async saveWorkerRecord(
    scope: string,
    pushApp: PushApp,
    subscription: PushSubscriptionJSON,
  ): Promise<void> {
    const record: SavedSubscription = {
      url: `${this.api.apiUrl!}/client/v1/push-subscription-change`,
      apiUrl: this.api.apiUrl!,
      clientKey: this.api.clientKey,
      sdk: SDK_NAME,
      pushAppId: pushApp.pushAppId,
      vapidPublicKey: pushApp.vapidPublicKey,
      subscription,
    };
    try {
      await withTimeout(saveSubscription(scope, record), WORKER_RECORD_TIMEOUT_MS);
    } catch (error) {
      this.log('debug', "Couldn't keep the subscription for the service worker", error);
    }
  }

  /**
   * Tells Kirora this browser's permission is denied, so it stops counting the browser as
   * reachable, and the device moves to `user` if someone else registered it. Only a
   * browser registered before can say so: the denial names that registration.
   */
  private async reportDenied(user: SignedInUser, config: string): Promise<void> {
    const last = this.lastRegistration();
    if (!last?.pushAppId || !last.lastSeenAt || last.config !== config) {
      return;
    }
    const reported = last.denied && last.userSubject === user.subject;
    if (reported && Date.now() - last.at <= REGISTRATION_REFRESH_MS) {
      return;
    }
    let answer: DeviceAnswer;
    try {
      answer = await this.putDevice(user, {
        pushAppId: last.pushAppId,
        permission: 'denied',
        lastSeenAt: last.lastSeenAt,
      });
    } catch (error) {
      // 409: registered again somewhere this browser doesn't know. 404: not this user's
      // device, or none. Nothing to say either way until permission is granted again.
      if (!isSettledRefusal(error)) {
        throw error;
      }
      this.storage.removeItem(this.registrationKey);
      return;
    }
    const denial: PushRegistration = {
      ...last,
      userSubject: user.subject,
      at: Date.now(),
      // A denial that moved the device to this user advances it, with a secret of its own.
      lastSeenAt: answer?.lastSeenAt ?? last.lastSeenAt,
      deviceSecret: answer?.deviceSecret ?? last.deviceSecret,
      denied: true,
    };
    this.storage.setItem(this.registrationKey, JSON.stringify(denial));
    this.log('debug', 'Told Kirora notifications are blocked in this browser');
  }

  /**
   * Detaches this browser from `user`, who is signing out, if it was registered. Resolves
   * once the first attempt ends, which gives up at `deadline` (epoch ms) if one is given.
   * Never rejects. If it fails, the browser's subscription is cancelled so no more pushes
   * show, and a network error, 429 or 5xx is retried in the background until it works, is
   * refused for good, or a day has passed. Kirora decides whether a retry is still
   * needed: it never detaches a registration made since (answering 409), whichever tab
   * made it, nor one that moved to someone else.
   */
  detach(user: SignedInUser, deadline?: number): Promise<void> {
    // In turn, so the record read is the one a registration still under way leaves: an
    // older `lastSeenAt` would have Kirora keep that registration (409).
    return this.oneAtATime(() => {
      const last = this.lastRegistration();

      // Registered for someone else (another tab's sign-in took it over): not this
      // user's to detach, nor their subscription to cancel.
      if (last && last.userSubject !== user.subject) {
        return Promise.resolve();
      }

      // With no record, it may still have been registered (its answer lost, or storage
      // full): detached unconditionally, wherever it could have been. Kirora answers 404
      // if there's nothing of this user's.
      const couldBeRegistered =
        this.options && webPushSupported() && Notification.permission === 'granted';
      if (!last && !couldBeRegistered) {
        return Promise.resolve();
      }

      return this.startCleanup(last, user, deadline);
    });
  }

  /**
   * Detaches this browser with nobody signed in (a reload where the app restored its own
   * session), by the device secret of its last registration, if it has one. As
   * `detach()` otherwise.
   */
  detachBySecret(deadline?: number): Promise<void> {
    return this.oneAtATime(async () => {
      const last = this.lastRegistration();
      // Without a usable apiUrl there's nowhere to send it.
      if (!last?.deviceSecret || this.api.apiUrl === undefined || !last.userSubject) {
        return;
      }

      // The registration is every tab's: while its user is signed in in another one,
      // or that can't be told, it isn't this logout's to undo.
      const elsewhere = await signedInElsewhere(this.api.namespace, last.userSubject);
      if (elsewhere !== false) {
        return;
      }
      await this.startCleanup(last, undefined, deadline);
    });
  }

  /** Detaches the registration `last` names (or, with none, any of `user`'s). In turn. */
  private startCleanup(
    last: PushRegistration | null,
    user: SignedInUser | undefined,
    deadline?: number,
  ): Promise<void> {
    // Forgotten now, so the user signing in again registers again.
    if (last) {
      this.storage.removeItem(this.registrationKey);
    }

    const cleanup: Cleanup = {
      user,
      installationId: this.installationId(),
      deviceSecret: last?.deviceSecret,
      lastSeenAt: last?.lastSeenAt,
      registered: last !== null,
      retryDelayMs: FIRST_CLEANUP_RETRY_MS,
      giveUpAt: Date.now() + CLEANUP_GIVE_UP_MS,
    };
    return this.attemptCleanup(cleanup, true, deadline);
  }

  /**
   * Carries on with a detachment a page before this one left still being retried, with
   * its device secret, within the day from the sign-out.
   */
  resumePendingDetach(): void {
    const pending = readJson(this.storage, this.pendingDetachKey) as PendingDetach | null;
    // Kept for a page whose apiUrl works: retrying here would only fail all day.
    if (!pending || this.api.apiUrl === undefined) {
      return;
    }
    const usable =
      typeof pending.installationId === 'string' &&
      typeof pending.deviceSecret === 'string' &&
      typeof pending.giveUpAt === 'number' &&
      Date.now() < pending.giveUpAt;
    if (!usable) {
      this.forgetPendingDetach();
      return;
    }

    const cleanup: Cleanup = {
      installationId: pending.installationId,
      deviceSecret: pending.deviceSecret,
      lastSeenAt: pending.lastSeenAt,
      // Its subscription was cancelled when the first attempt failed.
      registered: false,
      retryDelayMs: FIRST_CLEANUP_RETRY_MS,
      giveUpAt: pending.giveUpAt,
    };
    void this.oneAtATime(() => this.attemptCleanup(cleanup, false));
  }

  /** Stops detachments still being retried, and anything else on a timer. */
  destroy(): void {
    this.destroyed = true;
    for (const retry of this.retries) {
      clearTimeout(retry);
    }
    this.retries.clear();
  }

  /** One attempt at `cleanup`, run in turn with registrations. */
  private async attemptCleanup(
    cleanup: Cleanup,
    first: boolean,
    deadline?: number,
  ): Promise<void> {
    if (this.destroyed) {
      return;
    }

    try {
      await this.sendDetach(cleanup, deadline);
      this.log('debug', 'Detached this browser');
      this.forgetPendingDetach();
      return;
    } catch (error) {
      // 409: the user registered the browser again since, which Kirora kept. 404: there
      // was nothing of theirs here. Either way it's done, and the subscription is theirs.
      if (isSettledRefusal(error)) {
        this.forgetPendingDetach();
        return;
      }
      if (first && cleanup.registered) {
        await this.cancelSubscription();
      }
      // Destroyed while this attempt was on its way.
      if (this.destroyed) {
        return;
      }

      // Kept for a reload to carry on with only while it's being retried.
      if (this.retryCleanup(cleanup, error, first)) {
        this.keepPendingDetach(cleanup);
      } else {
        this.forgetPendingDetach();
      }
    }
  }

  /**
   * `DELETE /devices/<id>`, as the signed-out user while their token is held, otherwise
   * with the device secret. Only registrations up to `lastSeenAt` go, if it's known.
   */
  private async sendDetach(cleanup: Cleanup, deadline?: number): Promise<void> {
    let path = `/devices/${cleanup.installationId}`;
    if (cleanup.lastSeenAt) {
      path += `?lastSeenAt=${encodeURIComponent(cleanup.lastSeenAt)}`;
    }
    const timeoutMs = cleanupTimeout(deadline, cleanup.registered);

    if (cleanup.user) {
      try {
        // While the user is still signed in, an expired token is refreshed as for any
        // call. Once they've signed out, a refresh finds them gone and gives up, so a
        // token never comes through the next user's fetchUserToken.
        await this.api.request('DELETE', path, { as: cleanup.user, timeoutMs });
        return;
      } catch (error) {
        // Refused, the token can't detach; the device secret still can, from now on.
        if (!isTokenRefusal(error) || !cleanup.deviceSecret) {
          throw error;
        }
        cleanup.user = undefined;
      }
    }

    await this.api.requestWithSecret('DELETE', path, cleanup.deviceSecret!, {
      timeoutMs,
    });
  }

  /**
   * Tries `cleanup` again after its backoff, never sooner than `Retry-After`, if the
   * failure may pass and a day hasn't gone by; logs it otherwise. True if it will.
   */
  private retryCleanup(cleanup: Cleanup, error: unknown, first: boolean): boolean {
    const retryable = !(error instanceof KiroraApiError) || error.retryable;
    const retryAt = Date.now() + Math.max(cleanup.retryDelayMs, retryAfterOf(error));
    if (!retryable || retryAt > cleanup.giveUpAt) {
      this.log('error', "Couldn't detach this browser from the signed-out user", error);
      return false;
    }

    if (first) {
      this.log('debug', "Couldn't detach this browser yet; retrying", error);
    }
    cleanup.retryDelayMs = Math.min(cleanup.retryDelayMs * 2, MAX_CLEANUP_RETRY_MS);
    const retry = setTimeout(() => {
      this.retries.delete(retry);
      void this.oneAtATime(() => this.attemptCleanup(cleanup, false));
    }, retryAt - Date.now());
    this.retries.add(retry);
    return true;
  }

  /**
   * Keeps `cleanup` for a reload to carry on with, if a device secret can do it: the
   * user's token is never stored.
   */
  private keepPendingDetach(cleanup: Cleanup): void {
    if (!cleanup.deviceSecret) {
      return;
    }
    const pending: PendingDetach = {
      installationId: cleanup.installationId,
      lastSeenAt: cleanup.lastSeenAt,
      deviceSecret: cleanup.deviceSecret,
      giveUpAt: cleanup.giveUpAt,
    };
    this.storage.setItem(this.pendingDetachKey, JSON.stringify(pending));
  }

  private forgetPendingDetach(): void {
    this.storage.removeItem(this.pendingDetachKey);
  }

  /** Cancels the browser's push subscription, logging a failure. Never rejects. */
  private async cancelSubscription(): Promise<void> {
    if (!webPushSupported()) {
      return;
    }
    try {
      const worker = await navigator.serviceWorker.getRegistration(this.serviceWorkerUrl);
      if (!worker) {
        return;
      }
      // Forgotten first, or the worker could subscribe the browser again when the browser
      // reports the subscription gone.
      await forgetSubscription(worker.scope).catch((error: unknown) => {
        this.log('debug', "Couldn't forget the subscription kept for the worker", error);
      });
      const subscription = await worker.pushManager.getSubscription();
      if (subscription && !(await subscription.unsubscribe())) {
        this.log('error', "Couldn't cancel this browser's push subscription");
      }
    } catch (error) {
      this.log('error', "Couldn't cancel this browser's push subscription", error);
    }
  }

  /**
   * Runs registrations and detachments one at a time, in the order asked for, so Kirora
   * hears them in that order and the last one asked for is the one it keeps.
   */
  private oneAtATime(operation: () => Promise<void>): Promise<void> {
    const done = this.operations.then(operation);
    this.operations = done.catch(() => undefined);
    return done;
  }

  /** The workspace is in `registrationKey` already. */
  private config(options: KiroraPushOptions): string {
    return JSON.stringify([
      options.pushAppId ?? null,
      this.serviceWorkerUrl,
      this.installationId(),
    ]);
  }

  private lastRegistration(): PushRegistration | null {
    return readJson(this.storage, this.registrationKey) as PushRegistration | null;
  }

  /** The saved registration, if it's a granted one for this user and configuration. */
  private registeredFor(
    userSubject: string,
    config: string,
  ): PushRegistration | undefined {
    const last = this.lastRegistration();
    return last &&
      !last.denied &&
      last.userSubject === userSubject &&
      last.config === config
      ? last
      : undefined;
  }

  /** True if this user, configuration and subscription were registered in the last day. */
  private async registrationIsFresh(
    userSubject: string,
    config: string,
  ): Promise<boolean> {
    const last = this.registeredFor(userSubject, config);
    if (!last || Date.now() - last.at > REGISTRATION_REFRESH_MS) {
      return false;
    }
    return last.endpoint === (await currentSubscription(this.serviceWorkerUrl))?.endpoint;
  }

  /** Asks Kirora which app to use. Logs and returns undefined if none is set up. */
  private async choosePushApp(
    user: SignedInUser,
    pushAppId: string | undefined,
  ): Promise<PushApp | undefined> {
    const query = new URLSearchParams({ platform: 'web' });
    if (pushAppId) {
      query.set('pushAppId', pushAppId);
    }
    try {
      return await this.api.request<PushApp>('GET', `/push-app?${query.toString()}`, {
        as: user,
      });
    } catch (error) {
      if (!(error instanceof KiroraApiError && error.status === 404)) {
        throw error;
      }
      this.log('error', 'No ready web push app in this workspace');
      return undefined;
    }
  }
}

function webPushSupported(): boolean {
  try {
    // Without `navigator` (server rendering), reading it throws too.
    return (
      // A sandboxed frame has no origin to register a worker for, and some browsers
      // throw on reading `navigator.serviceWorker` there.
      globalThis.origin !== 'null' &&
      !!navigator.serviceWorker &&
      typeof PushManager !== 'undefined' &&
      typeof Notification !== 'undefined'
    );
  } catch {
    return false;
  }
}

/**
 * Gets or creates the push subscription. One made with a different VAPID key (e.g. the
 * push app was replaced) can't receive our pushes. It's replaced only if it's the one we
 * registered last; otherwise it belongs to another service, so it's left alone.
 */
async function pushSubscription(
  registration: ServiceWorkerRegistration,
  vapidPublicKey: string,
  last: PushRegistration | null,
  saved: SavedSubscription | undefined,
): Promise<PushSubscriptionJSON> {
  const applicationServerKey = base64UrlBytes(vapidPublicKey);
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    const ourRecord = recordOf(existing, last, saved);
    if (madeWithKey(existing, vapidPublicKey, applicationServerKey, ourRecord)) {
      return existing.toJSON();
    }
    if (!ourRecord) {
      throw new KiroraError(
        'this service worker already has a push subscription from another service',
      );
    }
    // Ours, but made with a key the push app no longer uses: replace it.
    await existing.unsubscribe();
  }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });
  return subscription.toJSON();
}

/**
 * How long a detachment may take before `deadline` (epoch ms), if there is one: early
 * enough to cancel a registered subscription by then if it fails. Out of time already,
 * it fails at once, so the subscription is cancelled now and the detachment is retried
 * in the background.
 */
function cleanupTimeout(
  deadline: number | undefined,
  registered: boolean,
): number | undefined {
  if (deadline === undefined) {
    return undefined;
  }
  const cancelling = registered ? CANCEL_TIME_MS : 0;
  return Math.max(deadline - Date.now() - cancelling, 1);
}

/**
 * Our record of `existing`, if it's the subscription we made: the page's record of what it
 * registered last, or failing that (a logout clears it), the worker's.
 */
function recordOf(
  existing: PushSubscription,
  last: PushRegistration | null,
  saved: SavedSubscription | undefined,
): Pick<PushRegistration, 'vapidPublicKey'> | null {
  if (last && existing.endpoint === last.endpoint) {
    return last;
  }
  if (saved?.subscription && existing.endpoint === saved.subscription.endpoint) {
    return { vapidPublicKey: saved.vapidPublicKey };
  }
  return null;
}

/**
 * Whether `existing` was made with the push app's key, `vapidPublicKey`, so it can be
 * reused. `ourRecord` is set if we made it.
 */
function madeWithKey(
  existing: PushSubscription,
  vapidPublicKey: string,
  applicationServerKey: Uint8Array,
  ourRecord: Pick<PushRegistration, 'vapidPublicKey'> | null,
): boolean {
  // Missing in Firefox before 75, which can't say which key made a subscription.
  const options = existing.options as PushSubscriptionOptions | undefined;
  if (options) {
    return sameKey(options.applicationServerKey, applicationServerKey);
  }
  // Then our own record says which key we used, if we made it; one saved before we
  // stored keys doesn't say, and is taken as made with ours.
  if (ourRecord) {
    return (
      ourRecord.vapidPublicKey === undefined ||
      ourRecord.vapidPublicKey === vapidPublicKey
    );
  }
  // With no record either, there's no telling, so it's taken as made with ours. Another
  // service's would then fail Kirora's pushes; but refusing could leave our own, its
  // records lost, never registered again.
  return true;
}

/**
 * Registers our worker and waits for it to be active, as subscribing needs. Refuses if
 * the site already has a different worker at its scope: registering would replace it (a
 * scope has one worker), breaking the site's own caching or pushes. That site should
 * import kirora-sw.js into its worker and name it instead.
 */
async function readyRegistration(
  serviceWorkerUrl: string,
): Promise<ServiceWorkerRegistration> {
  const scriptUrl = new URL(serviceWorkerUrl, location.href).href;
  const scope = new URL('./', scriptUrl).href;

  const existing = await navigator.serviceWorker.getRegistration(scope);
  if (existing) {
    const worker = existing.active ?? existing.waiting ?? existing.installing;
    const existingScript = worker ? worker.scriptURL : undefined;

    // The site registered this worker itself, perhaps at a wider scope: used as it is,
    // as registering again would add a second copy of it at the default scope.
    if (existingScript === scriptUrl) {
      await withTimeout(activated(existing), WORKER_ACTIVATION_TIMEOUT_MS);
      return existing;
    }

    // Only a different worker at the very scope we'd register would be replaced. One at
    // a wider scope keeps its pages, beside ours.
    if (existingScript && existing.scope === scope) {
      const path = new URL(existingScript).pathname;
      throw new KiroraError(
        `${path} is already this site's service worker. Add ` +
          `importScripts('/kirora-sw.js') to it and set push: { serviceWorkerUrl: '${path}' }`,
      );
    }
  }

  const registration = await navigator.serviceWorker.register(serviceWorkerUrl);
  // A worker stuck installing would otherwise hold up every later registration.
  await withTimeout(activated(registration), WORKER_ACTIVATION_TIMEOUT_MS);
  return registration;
}

/** The current subscription, without registering a service worker. */
async function currentSubscription(
  serviceWorkerUrl: string,
): Promise<PushSubscription | null | undefined> {
  const registration = await navigator.serviceWorker.getRegistration(serviceWorkerUrl);
  return registration?.pushManager.getSubscription();
}

/** Resolves once the registration's worker is active. */
function activated(registration: ServiceWorkerRegistration): Promise<void> {
  const worker = registration.installing ?? registration.waiting;
  if (registration.active || !worker) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') {
        resolve();
      }
      if (worker.state === 'redundant') {
        reject(new KiroraError('the service worker failed to install'));
      }
    });
  });
}

function sameKey(current: ArrayBuffer | null, wanted: Uint8Array): boolean {
  if (!current) {
    return false;
  }
  const currentBytes = new Uint8Array(current);
  return (
    currentBytes.length === wanted.length &&
    currentBytes.every((byte, index) => byte === wanted[index])
  );
}
