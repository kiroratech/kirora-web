/** Every error the SDK throws, so an app can catch them all with one `instanceof`. */
export class KiroraError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Kirora: ${message}`, options);
    this.name = 'KiroraError';
    // Chrome 93, Firefox 91 and Safari 15 are the first to take `cause` from options.
    if (options) this.cause = options.cause;
  }
}

/** The app's `fetchUserToken` failed or didn't answer. Queued events are retried later. */
export class UserTokenError extends KiroraError {
  constructor(cause: unknown) {
    super('fetchUserToken failed', { cause });
    this.name = 'UserTokenError';
  }
}

/** An error response from the Kirora API. */
export class KiroraApiError extends KiroraError {
  /** @internal Made by the SDK from Kirora's answer. */
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    /** From the `Retry-After` header, if any. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'KiroraApiError';
  }

  /** True for 408, 425, 429 and 5xx: the same call may succeed later. */
  get retryable(): boolean {
    return [408, 425, 429].includes(this.status) || this.status >= 500;
  }
}
