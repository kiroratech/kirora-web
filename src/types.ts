/**
 * The SDK's public types: everything an app passes in or gets back. Kept together so the
 * contract, shared with Kirora's other client SDKs, is reviewed in one place.
 */

export type KiroraOptions = {
  /** The workspace's public key, `kirora_pk_…`, from Developer → SDK in the dashboard. */
  clientKey: string;
  /**
   * Asks your server for a signed user token. Called by `identify()` without a token, and
   * again when Kirora refuses an expired one. Throw if it fails: queued events are kept.
   */
  fetchUserToken?: () => Promise<string>;
  /** Enables web push. Pass `true` for the defaults. */
  push?: true | PushOptions;
  /** Tracks `Page Viewed` on every page, including SPA navigations. Off by default. */
  trackPageViews?: boolean;
  /**
   * Tracks `Session Started` and adds `context.sessionId` to every event. On by default.
   * A session ends after 30 minutes without activity.
   */
  trackSessions?: boolean;
  /** Don't track or store anything until `setTrackingConsent(true)`, e.g. in the EU/UK. */
  requireTrackingConsent?: boolean;
  /** Defaults to `error`. `debug` also logs what's sent. */
  logLevel?: LogLevel;
  /**
   * Kirora's address, for staging or a private deployment, without a path: the SDK adds
   * its own. Defaults to `https://api.kirora.io`.
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

/** The VAPID key and other app settings come from Kirora. */
export type PushOptions = {
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
