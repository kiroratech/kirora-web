/**
 * Every name the SDK stores under, in `localStorage` and (as `kirora_…`) in cookies. The
 * README's "What the SDK stores" lists the same; keep the two in step.
 *
 * `namespace` is the workspace and API deployment (`<client key>@<api host and path>`), so
 * two clients on one site never share a queue, session, device id or choice.
 */
/** Every SDK key starts with this, and none of the site's should. */
export const STORAGE_KEY_PREFIX = 'kirora:';

export const STORAGE_KEYS = {
  /** Events waiting to be sent. */
  events: (namespace: string) => `kirora:events:${namespace}`,
  /** How many times the queue was written, so a tab can tell its copy is up to date. */
  eventsRevision: (namespace: string) => `kirora:events:${namespace}:revision`,
  /** Who this browser was last registered for push as. */
  pushRegistration: (namespace: string) => `kirora:push-registration:${namespace}`,
  /**
   * This browser's device secret, made once, as long-lived as its device id: it lets the
   * browser be detached from push with nobody signed in. Kept on this device only, never
   * in a cookie, which would send it with every request to the site.
   */
  deviceSecret: (namespace: string) => `kirora:device-secret:${namespace}`,
  /**
   * A detachment still being retried, with the device secret it goes with, so a reload
   * carries on with it (within the day from the sign-out).
   */
  pushPendingDetach: (namespace: string) => `kirora:push-pending-detach:${namespace}`,
  /** Set while `setPushEnabled(false)` holds: the device's choice, kept past sign-out. */
  pushDisabled: (namespace: string) => `kirora:push-disabled:${namespace}`,
  /** The live sessions, one per user: id, owner and last activity. Shared across subdomains. */
  session: (namespace: string) => `kirora:session:${namespace}`,
  /** `device.id`. Shared across subdomains. */
  installationId: (namespace: string) => `kirora:installation-id:${namespace}`,
  /** The visitor's tracking consent answer. */
  trackingConsent: (namespace: string) => `kirora:tracking-consent:${namespace}`,
  /** A second copy of a refusal, so a value lost or garbled in one key can't lose it. */
  trackingRefused: (namespace: string) => `kirora:tracking-refused:${namespace}`,
  /** Written and removed straight away, to check `localStorage` works. */
  probe: 'kirora:probe',
} as const;
