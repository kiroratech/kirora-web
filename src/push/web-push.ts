import { SDK_NAME, type ClientApi } from '../api/client-api.js';
import type { Identity, SignedInUser } from '../identity/identity.js';
import { KiroraApiError, KiroraError } from '../errors.js';
import { readJson, type KeyValueStorage } from '../storage/device-storage.js';
import { STORAGE_KEYS } from '../storage/keys.js';
import { localeAndTimezone } from '../tracking/page-context.js';
import { base64UrlBytes } from '../utils/base64url.js';
import { withTimeout } from '../utils/timeout.js';
import { savedSubscription } from './subscription-store.js';
import type { PushOptions, PushPermission, PushStatus } from '../types.js';
import type { Log } from '../utils/log.js';

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
  /** Set once Kirora was told permission is denied. */
  denied?: true;
};

/** What Kirora answers to `PUT /devices/{id}`. */
type DeviceAnswer = { lastSeenAt?: string } | undefined;

/**
 * Detaching a signed-out user's browser, retried in the background until it's done. The
 * user's token is kept in memory only, and never refreshed.
 */
type Cleanup = {
  user: SignedInUser;
  installationId: string;
  /** The push app the browser was last registered with, if known. */
  pushAppId: string | undefined;
  /** How long the next failure waits before trying again. */
  retryDelayMs: number;
  /** No retry after this (epoch ms). */
  giveUpAt: number;
  timer?: ReturnType<typeof setTimeout>;
};

const DEFAULT_SERVICE_WORKER_URL = '/kirora-sw.js';
const WORKER_ACTIVATION_TIMEOUT_MS = 30_000;
/** Re-register at most daily for the same user, configuration and subscription. */
const REGISTRATION_REFRESH_MS = 24 * 60 * 60_000;
/** A failed detachment is retried after this, doubling up to the maximum, for a day. */
const FIRST_CLEANUP_RETRY_MS = 30_000;
const MAX_CLEANUP_RETRY_MS = 5 * 60_000;
const CLEANUP_GIVE_UP_MS = 24 * 60 * 60_000;

/**
 * Permission prompt, push subscription and device registration. `options` is undefined
 * when push is off, but `detach()` still cleans up an old registration.
 */
export class WebPush {
  /** Per workspace, so it never vouches for another workspace's registration. */
  private readonly registrationKey: string;
  /** Set while `setPushEnabled(false)` holds. */
  private readonly disabledKey: string;
  private readonly serviceWorkerUrl: string;
  /** The registration or detachment running now, if any. Never rejects. */
  private operations: Promise<void> = Promise.resolve();
  /** Detachments still to finish, kept in memory only. */
  private readonly cleanups = new Set<Cleanup>();
  private destroyed = false;
  /** The user whose latest registration failed, so it can't be counted as registered. */
  private failedFor: SignedInUser | undefined;

  constructor(
    private readonly api: ClientApi,
    private readonly identity: Identity,
    private readonly storage: KeyValueStorage,
    private readonly options: PushOptions | undefined,
    private readonly installationId: () => string,
    private readonly log: Log,
  ) {
    this.registrationKey = STORAGE_KEYS.pushRegistration(api.namespace);
    this.disabledKey = STORAGE_KEYS.pushDisabled(api.namespace);
    this.serviceWorkerUrl = options?.serviceWorkerUrl ?? DEFAULT_SERVICE_WORKER_URL;
  }

  async requestPermission(): Promise<PushPermission> {
    if (!this.options || !webPushSupported()) return 'unsupported';
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      // Saying yes to the prompt is turning push on.
      this.storage.removeItem(this.disabledKey);
      await this.register();
    }
    // Reported too, but a failed report doesn't change the answer.
    if (permission === 'denied') {
      await this.register().catch((error: unknown) => {
        this.log('error', "Couldn't tell Kirora notifications are blocked", error);
      });
    }
    // `default` means the prompt was dismissed.
    return permission === 'default' ? 'unanswered' : permission;
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
    if (!user) return Promise.resolve();
    return this.oneAtATime(async () => {
      try {
        await this.registerAs(user);
        if (this.failedFor === user) this.failedFor = undefined;
      } catch (error) {
        this.failedFor = user;
        throw error;
      }
    });
  }

  /**
   * This browser's push, without prompting: the permission, then whether it's registered
   * for the user signed in now. Waits for a registration under way.
   */
  async status(): Promise<PushStatus> {
    if (!this.options || !webPushSupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    if (Notification.permission !== 'granted') return 'unanswered';
    await this.operations;
    const { user } = this.identity;
    const last = this.lastRegistration();
    const registered =
      user !== null &&
      this.failedFor !== user &&
      !this.disabled &&
      last !== null &&
      !last.denied &&
      last.userSubject === user.subject &&
      last.config === this.config(this.options);
    // The browser may have dropped its subscription since. One the worker replaced (and
    // told Kirora about) has a new endpoint, so any subscription counts.
    const subscribed = async () =>
      Boolean(await currentSubscription(this.serviceWorkerUrl).catch(() => undefined));
    return registered && (await subscribed()) ? 'enabled' : 'disabled';
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
    const { user } = this.identity;
    if (user) await this.detach(user);
    await this.oneAtATime(() => this.cancelSubscription());
  }

  private get disabled(): boolean {
    return this.storage.getItem(this.disabledKey) !== null;
  }

  private async registerAs(user: SignedInUser): Promise<void> {
    const { options } = this;
    const current = () => this.identity.user === user;
    if (!options || !current() || !webPushSupported() || this.disabled) return;
    const config = this.config(options);
    if (Notification.permission === 'denied') return this.reportDenied(user, config);
    if (Notification.permission !== 'granted') return;
    if ((await this.registrationIsFresh(user.subject, config)) || !current()) return;
    // Independent, so done together: which app to use, and a worker ready to subscribe.
    const [pushApp, worker] = await Promise.all([
      this.choosePushApp(user, options.pushAppId),
      readyRegistration(this.serviceWorkerUrl),
    ]);
    if (!pushApp || !current()) return;
    const subscription = await pushSubscription(
      worker,
      pushApp.vapidPublicKey,
      this.lastRegistration(),
    );
    if (!current()) return;
    const installationId = this.installationId();
    const answer = await this.api.request<DeviceAnswer>(
      'PUT',
      `/devices/${installationId}`,
      {
        as: user,
        body: {
          pushAppId: pushApp.pushAppId,
          targetKind: 'web_push_subscription',
          permission: 'granted',
          subscription,
          // For push reports. No app or OS version: Kirora reads the user agent.
          ...localeAndTimezone(),
        },
      },
    );
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
    };
    this.storage.setItem(this.registrationKey, JSON.stringify(registration));
    this.finishCleanups(user, installationId, pushApp.pushAppId);
    // For the worker, to tell Kirora when the browser replaces this subscription.
    await savedSubscription(worker.scope, {
      url: `${this.api.baseUrl!}/push-subscription-change`,
      clientKey: this.api.clientKey,
      sdk: SDK_NAME,
      pushAppId: pushApp.pushAppId,
      vapidPublicKey: pushApp.vapidPublicKey,
      subscription,
    }).catch((error: unknown) => {
      this.log('debug', "Couldn't keep the subscription for the service worker", error);
    });
    this.log('debug', `Registered this browser with ${pushApp.name}`);
  }

  /**
   * Tells Kirora this browser's permission is denied, so it stops counting the browser as
   * reachable, and the device moves to `user` if someone else registered it. Only a
   * browser registered before can say so: the denial names that registration.
   */
  private async reportDenied(user: SignedInUser, config: string): Promise<void> {
    const last = this.lastRegistration();
    if (!last?.pushAppId || !last.lastSeenAt || last.config !== config) return;
    const reported = last.denied && last.userSubject === user.subject;
    if (reported && Date.now() - last.at <= REGISTRATION_REFRESH_MS) return;
    const installationId = this.installationId();
    let answer: DeviceAnswer;
    try {
      answer = await this.api.request<DeviceAnswer>('PUT', `/devices/${installationId}`, {
        as: user,
        body: {
          pushAppId: last.pushAppId,
          permission: 'denied',
          lastSeenAt: last.lastSeenAt,
          ...localeAndTimezone(),
        },
      });
    } catch (error) {
      // 409: registered again somewhere this browser doesn't know. 404: not this user's
      // device, or none. Nothing to say either way until permission is granted again.
      const final = error instanceof KiroraApiError && [404, 409].includes(error.status);
      if (!final) throw error;
      this.storage.removeItem(this.registrationKey);
      return;
    }
    const denial: PushRegistration = {
      ...last,
      userSubject: user.subject,
      at: Date.now(),
      // A denial that moved the device to this user advances it.
      lastSeenAt: answer?.lastSeenAt ?? last.lastSeenAt,
      denied: true,
    };
    this.storage.setItem(this.registrationKey, JSON.stringify(denial));
    this.finishCleanups(user, installationId, last.pushAppId);
    this.log('debug', 'Told Kirora notifications are blocked in this browser');
  }

  get registered(): boolean {
    return this.storage.getItem(this.registrationKey) !== null;
  }

  /**
   * Detaches this browser from `user`, who is signing out, if it was registered. Resolves
   * once the first attempt ends, which gives up at `deadline` (epoch ms) if one is given.
   * Never rejects. If it fails, the browser's subscription is cancelled so no more pushes
   * show, and a network error, 429 or 5xx is retried in the background until it works, is
   * refused for good, or a day has passed. Signing someone else in doesn't stop it: only
   * their successful registration of this browser, which takes it over, does.
   */
  detach(user: SignedInUser, deadline?: number): Promise<void> {
    const last = this.lastRegistration();
    // Registered for someone else (another tab's sign-in took it over): not this user's
    // to detach, nor their subscription to cancel.
    if (!last || last.userSubject !== user.subject) return Promise.resolve();
    const cleanup: Cleanup = {
      user,
      installationId: this.installationId(),
      pushAppId: last.pushAppId,
      retryDelayMs: FIRST_CLEANUP_RETRY_MS,
      giveUpAt: Date.now() + CLEANUP_GIVE_UP_MS,
    };
    this.cleanups.add(cleanup);
    return this.oneAtATime(() => this.attemptCleanup(cleanup, true, deadline));
  }

  /** Stops detachments still being retried, and anything else on a timer. */
  destroy(): void {
    this.destroyed = true;
    for (const cleanup of this.cleanups) clearTimeout(cleanup.timer);
    this.cleanups.clear();
  }

  /** One attempt at `cleanup`, run in turn with registrations. */
  private async attemptCleanup(
    cleanup: Cleanup,
    first: boolean,
    deadline?: number,
  ): Promise<void> {
    // Done meanwhile, by a registration that took the browser over.
    if (!this.cleanups.has(cleanup) || this.destroyed) return;
    if (first) {
      // Forgotten now, so the user signing in again registers again.
      if (this.lastRegistration()?.userSubject === cleanup.user.subject) {
        this.storage.removeItem(this.registrationKey);
      }
    }
    const remaining = deadline === undefined ? undefined : deadline - Date.now();
    try {
      await this.api.request('DELETE', `/devices/${cleanup.installationId}`, {
        as: cleanup.user,
        // While the user is still signed in (the first attempt at logout, or turning push
        // off), an expired token is refreshed as for any call. Once they've signed out, a
        // refresh finds them gone and gives up, so it's never through the next user's.
        refresh: true,
        timeoutMs: remaining !== undefined && remaining > 0 ? remaining : undefined,
      });
      this.cleanups.delete(cleanup);
      this.log('debug', 'Detached this browser');
      return;
    } catch (error) {
      // A 404 means there was nothing of this user's here to detach.
      const nothingToDetach = error instanceof KiroraApiError && error.status === 404;
      if (first && !nothingToDetach) await this.cancelSubscription();
      const retryable = !(error instanceof KiroraApiError) || error.retryable;
      const retryAt =
        Date.now() +
        Math.max(
          cleanup.retryDelayMs,
          (error instanceof KiroraApiError && error.retryAfterMs) || 0,
        );
      // Destroyed, or done by a registration, while this attempt was on its way.
      if (this.destroyed || !this.cleanups.has(cleanup)) return;
      if (!retryable || retryAt > cleanup.giveUpAt) {
        this.cleanups.delete(cleanup);
        this.log('error', "Couldn't detach this browser from the signed-out user", error);
        return;
      }
      if (first) this.log('debug', "Couldn't detach this browser yet; retrying", error);
      cleanup.retryDelayMs = Math.min(cleanup.retryDelayMs * 2, MAX_CLEANUP_RETRY_MS);
      cleanup.timer = setTimeout(() => {
        void this.oneAtATime(() => this.attemptCleanup(cleanup, false));
      }, retryAt - Date.now());
    }
  }

  /**
   * After `user` registered this browser with `pushAppId`: detachments it makes needless
   * end. Its own earlier one would undo it if it landed now, and another user's for the
   * same push app is done, as the browser has moved. Another user's for another push
   * app carries on: Kirora only detaches that user's own installations.
   */
  private finishCleanups(
    user: SignedInUser,
    installationId: string,
    pushAppId: string | undefined,
  ): void {
    for (const cleanup of this.cleanups) {
      const sameApp = cleanup.pushAppId !== undefined && cleanup.pushAppId === pushAppId;
      if (cleanup.installationId !== installationId) continue;
      if (!sameApp && cleanup.user.subject !== user.subject) continue;
      clearTimeout(cleanup.timer);
      this.cleanups.delete(cleanup);
    }
  }

  /** Cancels the browser's push subscription, logging a failure. Never rejects. */
  private async cancelSubscription(): Promise<void> {
    // Forgotten first, or the worker could subscribe the browser again when the browser
    // reports the subscription gone.
    try {
      const worker = await navigator.serviceWorker.getRegistration(this.serviceWorkerUrl);
      if (worker) await savedSubscription(worker.scope, null);
    } catch (error) {
      this.log('debug', "Couldn't forget the subscription kept for the worker", error);
    }
    try {
      if (!(await unsubscribe(this.serviceWorkerUrl))) {
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
  private config(options: PushOptions): string {
    return JSON.stringify([
      options.pushAppId ?? null,
      this.serviceWorkerUrl,
      this.installationId(),
    ]);
  }

  private lastRegistration(): PushRegistration | null {
    return readJson(this.storage, this.registrationKey) as PushRegistration | null;
  }

  /** True if this user, configuration and subscription were registered in the last day. */
  private async registrationIsFresh(
    userSubject: string,
    config: string,
  ): Promise<boolean> {
    const last = this.lastRegistration();
    if (!last || last.denied || Date.now() - last.at > REGISTRATION_REFRESH_MS) {
      return false;
    }
    if (last.userSubject !== userSubject || last.config !== config) return false;
    return last.endpoint === (await currentSubscription(this.serviceWorkerUrl))?.endpoint;
  }

  /** Asks Kirora which app to use. Logs and returns undefined if none is set up. */
  private async choosePushApp(
    user: SignedInUser,
    pushAppId: string | undefined,
  ): Promise<PushApp | undefined> {
    const query = new URLSearchParams({ platform: 'web' });
    if (pushAppId) query.set('pushAppId', pushAppId);
    try {
      return await this.api.request<PushApp>('GET', `/push-app?${query.toString()}`, {
        as: user,
      });
    } catch (error) {
      if (!(error instanceof KiroraApiError && error.status === 404)) throw error;
      this.log('error', 'No ready web push app in this workspace');
      return undefined;
    }
  }
}

function webPushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof PushManager !== 'undefined' &&
    typeof Notification !== 'undefined'
  );
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
): Promise<PushSubscriptionJSON> {
  const applicationServerKey = base64UrlBytes(vapidPublicKey);
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    // The record of what we registered last, if this subscription is the one we made.
    const ourRecord = existing.endpoint === last?.endpoint ? last : null;
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
 * Whether `existing` was made with the push app's key, `vapidPublicKey`, so it can be
 * reused. `ourRecord` is set if we made it.
 */
function madeWithKey(
  existing: PushSubscription,
  vapidPublicKey: string,
  applicationServerKey: Uint8Array,
  ourRecord: PushRegistration | null,
): boolean {
  // Missing in Firefox before 75, which can't say which key made a subscription.
  const options = existing.options as PushSubscriptionOptions | undefined;
  if (options) return sameKey(options.applicationServerKey, applicationServerKey);
  // Then our own record says which key we used, if we made it (records saved before we
  // started storing the key don't say).
  if (ourRecord?.vapidPublicKey !== undefined) {
    return ourRecord.vapidPublicKey === vapidPublicKey;
  }
  // Otherwise there's no telling, so it's taken as made with ours.
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
  const existing = await navigator.serviceWorker.getRegistration(
    new URL('./', scriptUrl).href,
  );
  const existingScript = (existing?.active ?? existing?.waiting ?? existing?.installing)
    ?.scriptURL;
  if (existingScript && existingScript !== scriptUrl) {
    const path = new URL(existingScript).pathname;
    throw new KiroraError(
      `${path} is already this site's service worker. Add ` +
        `importScripts('/kirora-sw.js') to it and set push: { serviceWorkerUrl: '${path}' }`,
    );
  }
  const registration = await navigator.serviceWorker.register(serviceWorkerUrl);
  // A worker stuck installing would otherwise hold up every later registration.
  await withTimeout(activated(registration), WORKER_ACTIVATION_TIMEOUT_MS);
  return registration;
}

/** Cancels this browser's push subscription. True if there's none left. */
async function unsubscribe(serviceWorkerUrl: string): Promise<boolean> {
  if (!webPushSupported()) return true;
  const subscription = await currentSubscription(serviceWorkerUrl);
  return subscription ? subscription.unsubscribe() : true;
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
  if (registration.active || !worker) return Promise.resolve();
  return new Promise((resolve, reject) => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') resolve();
      if (worker.state === 'redundant') {
        reject(new KiroraError('the service worker failed to install'));
      }
    });
  });
}

function sameKey(current: ArrayBuffer | null, wanted: Uint8Array): boolean {
  if (!current) return false;
  const currentBytes = new Uint8Array(current);
  return (
    currentBytes.length === wanted.length &&
    currentBytes.every((byte, index) => byte === wanted[index])
  );
}
