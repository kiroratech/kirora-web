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

export type LogLevel = 'none' | 'error' | 'debug';

/** An event's properties. They must be JSON: values JSON can't hold are dropped. */
export type EventProperties = Record<string, unknown>;
