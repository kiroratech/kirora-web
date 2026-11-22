import { DEFAULT_API_URL } from './default-api-url.js';
import {
  asKiroraError,
  fieldErrors,
  KiroraApiError,
  KiroraError,
  type FieldError,
} from '../errors.js';
import type { Identity, SignedInUser } from '../identity/identity.js';
import type { KiroraOptions } from '../types.js';
import { withTimeout } from '../utils/timeout.js';
import { retryAfterMs } from '../utils/retry-after.js';
import { urlOf } from '../utils/url.js';
import { SDK_VERSION } from '../version.js';

export const SDK_NAME = `kirora-web/${SDK_VERSION}`;

type ClientApiOptions = Pick<KiroraOptions, 'apiUrl' | 'clientKey'>;

type RequestOptions = {
  body?: unknown;
  keepalive?: boolean;
  /** The user to send as, if not whoever is signed in now. */
  as?: SignedInUser;
  /** Cancels the call, which then fails as a network error would. */
  signal?: AbortSignal;
  /** Gives up sooner than the usual 30 seconds, e.g. within logout()'s deadline. */
  timeoutMs?: number;
  /** Told a successful answer's `Retry-After`, for what it left unsettled. */
  onRetryAfter?: (delayMs: number) => void;
};

/** A request still unanswered after this is abandoned and treated as a network failure. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Transport for `/client/v1`: headers, timeouts and errors, sent as the signed-in user.
 * On a 401 it asks `identity` for a fresh token once and repeats the call.
 */
export class ClientApi {
  /**
   * `apiUrl` without a trailing slash. Undefined if it isn't an address: then every
   * request fails with `urlProblem`.
   */
  readonly apiUrl: string | undefined;
  readonly clientKey: string;
  /** Keeps one workspace's stored state apart from another's on the same site. */
  readonly namespace: string;
  /** Why `apiUrl` can't be used, if it can't. The constructor never throws. */
  readonly urlProblem: string | undefined;

  constructor(
    options: ClientApiOptions,
    private readonly identity: Identity,
  ) {
    const apiUrl = options.apiUrl ?? DEFAULT_API_URL;
    const url = urlOf(apiUrl);
    // `api.example.com:443` parses too, as a URL with scheme `api.example.com:`.
    const web = url && /^https?:$/.test(url.protocol) ? url : undefined;
    // Path and all, without a trailing slash.
    const path = web?.pathname.replace(/\/+$/, '');
    if (web) {
      // As Kirora writes its own addresses: host in lower case, no default port. The
      // worker matches tracking URLs against it.
      this.apiUrl = web.origin + path;
    } else {
      this.urlProblem = `apiUrl must be an address like ${DEFAULT_API_URL}`;
    }
    // Per deployment. A malformed apiUrl still gets a namespace of its own, never a real
    // workspace's.
    this.namespace = `${options.clientKey}@${web ? web.host + path : apiUrl}`;
    this.clientKey = options.clientKey;
  }

  /**
   * Sends as the current user. On a 401 it asks for a fresh token once and repeats the
   * call, but never as a different user: if the app signed someone else in meanwhile,
   * the 401 is thrown instead.
   */
  async request<Data>(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    options: RequestOptions = {},
  ): Promise<Data | undefined> {
    if (this.apiUrl === undefined) throw new KiroraError(this.urlProblem!);
    const user = options.as ?? this.identity.user;
    if (!user) throw new KiroraError('call identify() with a user token first');
    // Refused for good: asking Kirora again would only be refused again.
    if (this.identity.tokenRefused(user)) throw refusal();
    await this.identity.tokenReady(user);
    const sentToken = user.token;
    const answer = await this.send(this.apiUrl, method, path, sentToken, options);
    if (answer !== REFUSED) return this.accepted(user, answer as Data | undefined);

    // Kirora refused the token: get a fresh one, once, and try again with it.
    const freshToken = await this.identity.refresh(user, sentToken);
    if (freshToken) {
      const retried = await this.send(this.apiUrl, method, path, freshToken, options);
      if (retried !== REFUSED) return this.accepted(user, retried as Data | undefined);
    }
    throw refusal();
  }

  /** A 2xx answer: Kirora took `user`'s token. */
  private accepted<Data>(user: SignedInUser, data: Data): Data {
    this.identity.tokenAccepted(user);
    return data;
  }

  /**
   * One call, answer and all: the timeout covers reading the body too, since a body that
   * stops arriving would otherwise hold the call open for good. Returns `REFUSED` for a
   * 401, so the caller can refresh the token.
   */
  private async send(
    apiUrl: string,
    method: string,
    path: string,
    userToken: string,
    options: RequestOptions,
  ): Promise<unknown> {
    const hasBody = options.body !== undefined;
    // AbortSignal.timeout() and AbortSignal.any() are newer than the browsers we support.
    const abort = new AbortController();
    const cancel = () => abort.abort();
    if (options.signal?.aborted) cancel();
    options.signal?.addEventListener('abort', cancel);
    const exchange = async () => {
      const call = (keepalive?: boolean) =>
        fetch(`${apiUrl}/client/v1${path}`, {
          method,
          headers: {
            authorization: `Bearer ${userToken}`,
            'kirora-client-key': this.clientKey,
            'kirora-sdk': SDK_NAME,
            ...(hasBody ? { 'content-type': 'application/json' } : {}),
          },
          body: hasBody ? JSON.stringify(options.body) : undefined,
          keepalive,
          signal: abort.signal,
        });
      // Chrome 80 refuses keepalive for a request needing a CORS preflight, as ours do:
      // tried again without, which still goes if the page is only hidden, not closing.
      const response = await call(options.keepalive).catch((error: unknown) => {
        if (!options.keepalive || abort.signal.aborted) throw error;
        return call();
      });
      if (response.status === 401) {
        // Not read, so let the connection go.
        response.body?.cancel().catch(() => undefined);
        return REFUSED;
      }
      if (!response.ok) throw await toApiError(response);
      const delayMs = retryAfterMs(response.headers.get('retry-after'));
      if (delayMs) options.onRetryAfter?.(delayMs);
      if (response.status === 204) return undefined;
      return ((await response.json()) as { data: unknown }).data;
    };
    try {
      return await withTimeout(exchange(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    } catch (error) {
      // Offline, timed out, cancelled, or an answer that isn't Kirora's.
      throw asKiroraError(error, "couldn't reach Kirora: ");
    } finally {
      // Lets go of the call if it timed out; does nothing once it's answered.
      abort.abort();
      options.signal?.removeEventListener('abort', cancel);
    }
  }
}

/** A 401, as the caller sees it once a fresh token can't help. */
function refusal(): KiroraApiError {
  return new KiroraApiError(401, undefined, 'Kirora answered 401');
}

/** What `send()` returns for a 401. */
const REFUSED = Symbol();

async function toApiError(response: Response): Promise<KiroraApiError> {
  const body = (await response.json().catch(() => undefined)) as
    { error?: { code?: string; message?: string; errors?: unknown } } | undefined;
  const error = new KiroraApiError(
    response.status,
    body?.error?.code,
    body?.error?.message ?? `Kirora answered ${response.status}`,
    retryAfterMs(response.headers.get('retry-after')),
  );
  const errors = body?.error?.errors;
  if (Array.isArray(errors)) fieldErrors.set(error, errors as FieldError[]);
  return error;
}
