/**
 * The SDK's public types: everything an app passes in or gets back. Kept together so the
 * contract, shared with Kirora's other client SDKs, is reviewed in one place.
 */

export type KiroraOptions = {
  /** The workspace's public key, `kirora_pk_…`, from Developer → SDK in the dashboard. */
  clientKey: string;
  /**
   * Asks your server for a signed user token. Called by `identify()` without a token, a
   * minute before the token's `exp` (and as the page is shown again past that), and when
   * Kirora refuses one. Throw if it fails, or answer `null` when there's no token: either
   * way it counts as a failed fetch (a `UserTokenError`), and queued events are kept.
   */
  fetchUserToken?: () => Promise<string | null | undefined>;
  /**
   * Called when the signed-in user's token fails in the background, where no method call
   * would tell you: `fetch_failed` (`fetchUserToken` threw, answered no token or timed
   * out) or `refused` (Kirora refused it and no fresh one was accepted). A failed early
   * refresh is retried until the token expires, and reported only if a refresh still
   * fails then or Kirora refuses it. Once per failure, until a request with the user's
   * token succeeds or `identify()` is called. Called on its own, and only if that user is
   * still signed in: never after `destroy()` or another sign-in, while `logout()` signs
   * the user out, or for a failure a method rejects with. Sign the user out, or ask them
   * to sign in again.
   */
  onAuthenticationFailed?: (reason: AuthenticationFailureReason) => void;
  /** Enables web push. Pass `true` for the defaults. */
  push?: true | KiroraPushOptions;
  /** Tracks `Page Viewed` on every page, including SPA navigations. Off by default. */
  trackPageViews?: boolean;
  /**
   * Tracks `Session Started` and adds `context.sessionId` to every event. On by default.
   * A session ends after 30 minutes without activity.
   */
  trackSessions?: boolean;
  /** Don't track or store anything until `setTrackingConsent(true)`, e.g. in the EU/UK. */
  requireTrackingConsent?: boolean;
  /** Defaults to `error`. `debug` also logs how many events were sent, and retries. */
  logLevel?: LogLevel;
  /**
   * Kirora's address, for staging or a private deployment, with its path if it has one:
   * the SDK adds `/client/v1` after it. Each address keeps its own queue, session, device
   * id and consent. Defaults to `https://api.kirora.io`.
   */
  apiUrl?: string;
  /**
   * Redacts or drops an event before it's stored or sent: called once per event,
   * automatic ones included, with a copy of its name, properties and context. Return the
   * event with fields changed or removed, or `null` to drop it. It must answer at once:
   * an error, a promise or values JSON can't hold drop the event. The name, time and
   * idempotency key stay the SDK's.
   */
  beforeSend?: (event: BeforeSendEvent) => BeforeSendEvent | null;
};

/** An event as `beforeSend` sees it: a copy, so changing it changes nothing else. */
export type BeforeSendEvent = {
  name: string;
  properties: EventProperties;
  /** The page, session, device, locale and campaign the SDK collected. */
  context: Record<string, unknown>;
};

/** Why `onAuthenticationFailed` was called. Same values on every Kirora SDK. */
export type AuthenticationFailureReason = 'fetch_failed' | 'refused';

/**
 * Hears a tap on a Kirora push or one of its buttons, with the push's `data`, after the
 * tap was reported. The tap's link (if any) opens first.
 */
export type NotificationClickListener = (data: Record<string, string>) => void;

/** The VAPID key and other app settings come from Kirora. */
export type KiroraPushOptions = {
  /** Only needed if the workspace has more than one web push app. */
  pushAppId?: string;
  /** Your service worker. Defaults to `/kirora-sw.js`. Must be on your own origin. */
  serviceWorkerUrl?: string;
};

/** The answer to `requestPushPermission()`. Same values on every Kirora SDK. */
export type PushPermission = 'granted' | 'denied' | 'unanswered' | 'unsupported';

/**
 * The answer to `getPushStatus()`. Same values on every Kirora SDK. The browser's
 * permission comes first; with it granted, `enabled` when this browser is registered for
 * the signed-in user.
 */
export type PushStatus = 'enabled' | 'disabled' | 'denied' | 'unanswered' | 'unsupported';

export type LogLevel = 'none' | 'error' | 'debug';

/** An event's properties. They must be JSON: values JSON can't hold are dropped. */
export type EventProperties = Record<string, unknown>;
