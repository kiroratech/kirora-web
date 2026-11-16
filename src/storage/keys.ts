/**
 * Every name the SDK stores under, in `localStorage` and (as `kirora_…`) in cookies. The
 * README's "What the SDK stores" lists the same; keep the two in step.
 *
 * `namespace` is the workspace and API deployment (`<client key>@<api host>`), so two
 * clients on one site never share a queue, session, device id or choice.
 */
export const STORAGE_KEYS = {
  /** Events waiting to be sent. */
  events: (namespace: string) => `kirora:events:${namespace}`,
  /** Who this browser was last registered for push as. */
  pushRegistration: (namespace: string) => `kirora:push-registration:${namespace}`,
  /** Set while `setPushEnabled(false)` holds: the device's choice, kept past sign-out. */
  pushDisabled: (namespace: string) => `kirora:push-disabled:${namespace}`,
  /** The current session: its id, owner and last activity. Shared across subdomains. */
  session: (namespace: string) => `kirora:session:${namespace}`,
  /** `device.id`. Shared across subdomains. */
  installationId: (namespace: string) => `kirora:installation-id:${namespace}`,
  /** The visitor's tracking consent answer. */
  trackingConsent: (namespace: string) => `kirora:tracking-consent:${namespace}`,
  /** Written and removed straight away, to check `localStorage` works. */
  probe: 'kirora:probe',
} as const;
