import type { ClientApi } from '../api/client-api.js';
import type { Identity, SignedInUser } from '../identity/identity.js';
import { KiroraApiError, KiroraError } from '../errors.js';
import { readJson, type KeyValueStorage } from '../storage/device-storage.js';
import { STORAGE_KEYS } from '../storage/keys.js';
import { base64UrlDecode } from '../utils/base64url.js';
import { withTimeout } from '../utils/timeout.js';
import type { PushOptions, PushPermission } from '../types.js';
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
};

const DEFAULT_SERVICE_WORKER_URL = '/kirora-sw.js';
const WORKER_ACTIVATION_TIMEOUT_MS = 30_000;
/** Re-register at most daily for the same user, configuration and subscription. */
const REGISTRATION_REFRESH_MS = 24 * 60 * 60_000;

/**
 * Permission prompt, push subscription and device registration. `options` is undefined
 * when push is off, but `unregister()` still cleans up an old registration.
 */
export class WebPush {
  /** Per workspace, so it never vouches for another workspace's registration. */
  private readonly registrationKey: string;
  private readonly serviceWorkerUrl: string;
  /** The registration or detachment running now, if any. Never rejects. */
  private operations: Promise<void> = Promise.resolve();

  constructor(
    private readonly api: ClientApi,
    private readonly identity: Identity,
    private readonly storage: KeyValueStorage,
    private readonly options: PushOptions | undefined,
    private readonly installationId: () => string,
    private readonly log: Log,
  ) {
    this.registrationKey = STORAGE_KEYS.pushRegistration(api.namespace);
    this.serviceWorkerUrl = options?.serviceWorkerUrl ?? DEFAULT_SERVICE_WORKER_URL;
  }

  async requestPermission(): Promise<PushPermission> {
    if (!this.options || !webPushSupported()) return 'unsupported';
    const permission = await Notification.requestPermission();
    if (permission === 'granted') await this.register();
    // `default` means the prompt was dismissed.
    return permission === 'default' ? 'unanswered' : permission;
  }

  /**
   * Registers this browser for push as the user signed in now, if permission is granted.
   * Gives up as soon as someone else signs in (or nobody is), so an earlier user's
   * registration never lands after a later one's.
   */
  register(): Promise<void> {
    // Captured now: the registration is for this user, or nobody.
    const { user } = this.identity;
    return user ? this.oneAtATime(() => this.registerAs(user)) : Promise.resolve();
  }

  private async registerAs(user: SignedInUser): Promise<void> {
    const { options } = this;
    const current = () => this.identity.user === user;
    if (!options || !current() || !webPushSupported()) return;
    if (Notification.permission !== 'granted') return;
    const config = this.config(options);
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
    await this.api.request('PUT', `/devices/${this.installationId()}`, {
      as: user,
      body: {
        pushAppId: pushApp.pushAppId,
        targetKind: 'web_push_subscription',
        permission: 'granted',
        subscription,
      },
    });
    // Saved even if the user changed meanwhile: it records who Kirora now has, so the
    // next user's registration (queued behind this one) isn't skipped as fresh.
    const registration: PushRegistration = {
      userSubject: user.subject,
      config,
      endpoint: subscription.endpoint!,
      vapidPublicKey: pushApp.vapidPublicKey,
      at: Date.now(),
    };
    this.storage.setItem(this.registrationKey, JSON.stringify(registration));
    this.log('debug', `Registered this browser with ${pushApp.name}`);
  }

  get registered(): boolean {
    return this.storage.getItem(this.registrationKey) !== null;
  }

  /**
   * Detaches this browser from `user`. If Kirora can't be told (e.g. offline), the
   * browser's subscription is cancelled instead, which stops pushes all the same; it's
   * only thrown if both fail. Does nothing once someone else signs in: their registration,
   * queued behind this, takes the browser over, and detaching would undo it.
   */
  unregister(user: SignedInUser): Promise<void> {
    return this.oneAtATime(async () => {
      if (!this.registered || this.identity.user !== user) return;
      try {
        await this.api.request('DELETE', `/devices/${this.installationId()}`, {
          as: user,
        });
      } catch (error) {
        const unsubscribed = await unsubscribe(this.serviceWorkerUrl).catch(() => false);
        if (!unsubscribed) throw error;
        this.log(
          'error',
          "Couldn't detach this browser, so unsubscribed it from push",
          error,
        );
      }
      this.storage.removeItem(this.registrationKey);
    });
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
    if (!last || Date.now() - last.at > REGISTRATION_REFRESH_MS) return false;
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
    const ours = existing.endpoint === last?.endpoint;
    // Browsers without `options` (Firefox before 75) can't say which key made it: it's
    // taken as made with ours, unless it's ours and we know we used another.
    const options = existing.options as PushSubscriptionOptions | undefined;
    const sameKeyUsed = options
      ? sameKey(options.applicationServerKey, applicationServerKey)
      : !ours ||
        last?.vapidPublicKey === undefined ||
        last.vapidPublicKey === vapidPublicKey;
    if (sameKeyUsed) return existing.toJSON();
    if (!ours) {
      throw new KiroraError(
        'this service worker already has a push subscription from another service',
      );
    }
    await existing.unsubscribe();
  }
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });
  return subscription.toJSON();
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
  if (!webPushSupported()) return false;
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

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(base64UrlDecode(value), (character) => character.charCodeAt(0));
}

function sameKey(current: ArrayBuffer | null, wanted: Uint8Array): boolean {
  if (!current) return false;
  const currentBytes = new Uint8Array(current);
  return (
    currentBytes.length === wanted.length &&
    currentBytes.every((byte, index) => byte === wanted[index])
  );
}
