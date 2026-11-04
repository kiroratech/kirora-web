/**
 * Every name the SDK stores under, in `localStorage` and (as `kirora_…`) in cookies. The
 * README's "What the SDK stores" lists the same; keep the two in step.
 */
export const STORAGE_KEYS = {
  /** Events waiting to be sent, per workspace. */
  events: (namespace: string) => `kirora:events:${namespace}`,
  /** Who this browser was last registered for push as, per workspace. */
  pushRegistration: (namespace: string) => `kirora:push-registration:${namespace}`,
  /** The current session: its id and last activity. Shared across subdomains. */
  session: 'kirora:session',
  /** `device.id`. Shared across subdomains. */
  installationId: 'kirora:installation-id',
  /** The visitor's tracking consent answer. */
  trackingConsent: 'kirora:tracking-consent',
  /** Written and removed straight away, to check `localStorage` works. */
  probe: 'kirora:probe',
} as const;
