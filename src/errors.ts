/** Every error the SDK throws, so an app can catch them all with one `instanceof`. */
export class KiroraError extends Error {
  // Not `ErrorOptions`, which apps compiled without ES2022's lib can't name.
  constructor(message: string, options?: { cause?: unknown }) {
    super(`Kirora: ${message}`, options);
    this.name = 'KiroraError';
    // Chrome 93, Firefox 91 and Safari 15 are the first to take `cause` from options.
    if (options) this.cause = options.cause;
  }
}

/**
 * @internal What a public method rejects with: the SDK's own errors as they are, anything
 * else as a `KiroraError` caused by it, its message after `prefix`.
 */
export function asKiroraError(error: unknown, prefix = ''): KiroraError {
  if (error instanceof KiroraError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new KiroraError(prefix + reason, { cause: error });
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

/** @internal What a refusal says was wrong in the request, by part and dotted field. */
export type FieldError = { in?: unknown; field?: unknown };

/** @internal The `errors` of each refusal that lists any. Not part of the public error. */
export const fieldErrors = new WeakMap<KiroraApiError, FieldError[]>();
