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
    this.clientKey = options.clientKey;

    const url = urlOf(apiUrl);
    // `api.example.com:443` parses too, as a URL with scheme `api.example.com:`.
    if (!url || !/^https?:$/.test(url.protocol)) {
      this.urlProblem = `apiUrl must be an address like ${DEFAULT_API_URL}`;
      // A malformed apiUrl still gets a namespace of its own, never a real workspace's.
      this.namespace = `${options.clientKey}@${apiUrl}`;
      return;
    }

    // Path and all, without a trailing slash.
    const path = url.pathname.replace(/\/+$/, '');
    // As Kirora writes its own addresses: host in lower case, no default port. The
    // worker matches tracking URLs against it.
    this.apiUrl = url.origin + path;
    // Per deployment.
    this.namespace = `${options.clientKey}@${url.host}${path}`;
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
    if (this.apiUrl === undefined) {
      throw new KiroraError(this.urlProblem!);
    }
    const user = options.as ?? this.identity.user;
    if (!user) {
      throw new KiroraError('call identify() with a user token first');
    }
    // Refused for good: asking Kirora again would only be refused again.
    if (this.identity.tokenRefused(user)) {
      throw refusal();
    }
    await this.identity.tokenReady(user);
    const { apiUrl } = this;
    const sendWith = (token: string) =>
      this.send(apiUrl, method, path, `Bearer ${token}`, options);

    const sentToken = user.token;
    const answer = await sendWith(sentToken);
    if (answer !== REFUSED) {
      return this.accepted(user, answer as Data | undefined);
    }

    // Kirora refused the token: get a fresh one, once, and try again with it.
    const freshToken = await this.identity.refresh(user, sentToken);
    if (freshToken) {
      const retried = await sendWith(freshToken);
      if (retried !== REFUSED) {
        return this.accepted(user, retried as Data | undefined);
      }
    }
    throw refusal();
  }

  /**
   * Sends with a device secret (`Authorization: Device <secret>`) instead of a user's
   * token: for detaching a device with nobody signed in. There's no token to refresh, so
   * a 401 is final.
   */
  async requestWithSecret<Data>(
    method: 'DELETE',
    path: string,
    deviceSecret: string,
    options: Omit<RequestOptions, 'as'> = {},
  ): Promise<Data | undefined> {
    if (this.apiUrl === undefined) {
      throw new KiroraError(this.urlProblem!);
    }
    const answer = await this.send(
      this.apiUrl,
      method,
      path,
      `Device ${deviceSecret}`,
      options,
    );
    if (answer === REFUSED) {
      throw refusal();
    }
    return answer as Data | undefined;
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
    authorization: string,
    options: RequestOptions,
  ): Promise<unknown> {
    // AbortSignal.timeout() and AbortSignal.any() are newer than the browsers we support,
    // so the caller's signal is linked to one of our own, which the timeout also ends.
    const abort = new AbortController();
    const cancel = () => abort.abort();
    if (options.signal?.aborted) {
      cancel();
    }
    options.signal?.addEventListener('abort', cancel);

    const url = `${apiUrl}/client/v1${path}`;
    const request: RequestInit = {
      method,
      headers: this.headers(authorization, options.body !== undefined),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: abort.signal,
    };
    const exchange = async () => {
      const response = await fetchWithKeepalive(url, request, options.keepalive === true);
      return readAnswer(response, options);
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

  private headers(authorization: string, hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      authorization,
      'kirora-client-key': this.clientKey,
      'kirora-sdk': SDK_NAME,
    };
    if (hasBody) {
      headers['content-type'] = 'application/json';
    }
    return headers;
  }
}

/**
 * Fetches `request`, with `keepalive` if asked. Chrome 80 refuses keepalive for a request
 * needing a CORS preflight, as ours do: tried again without, which still goes if the page
 * is only hidden.
 */
async function fetchWithKeepalive(
  url: string,
  request: RequestInit,
  keepalive: boolean,
): Promise<Response> {
  if (!keepalive) {
    return fetch(url, request);
  }
  try {
    return await fetch(url, { ...request, keepalive: true });
  } catch (error) {
    if (request.signal?.aborted) {
      throw error;
    }
    return fetch(url, request);
  }
}

/**
 * Kirora's answer: its `data`, `REFUSED` for a 401 (so the caller can refresh the token),
 * or a `KiroraApiError`. A successful answer's `Retry-After` goes to `onRetryAfter`.
 */
async function readAnswer(response: Response, options: RequestOptions): Promise<unknown> {
  if (response.status === 401) {
    // Not read, so let the connection go.
    response.body?.cancel().catch(() => undefined);
    return REFUSED;
  }
  if (!response.ok) {
    throw await toApiError(response);
  }

  const delayMs = retryAfterMs(response.headers.get('retry-after'));
  if (delayMs) {
    options.onRetryAfter?.(delayMs);
  }

  if (response.status === 204) {
    return undefined;
  }
  return ((await response.json()) as { data: unknown }).data;
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
  if (Array.isArray(errors)) {
    fieldErrors.set(error, errors as FieldError[]);
  }
  return error;
}
