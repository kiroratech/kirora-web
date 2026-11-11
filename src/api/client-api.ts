import { KiroraApiError, KiroraError } from '../errors.js';
import type { Identity, SignedInUser } from '../identity/identity.js';
import type { KiroraOptions } from '../types.js';
import { withTimeout } from '../utils/timeout.js';
import { urlOf } from '../utils/url.js';
import { SDK_VERSION } from '../version.js';

const SDK_NAME = `kirora-web/${SDK_VERSION}`;
const DEFAULT_API_URL = 'https://api.kirora.io';

type ClientApiOptions = Pick<KiroraOptions, 'apiUrl' | 'clientKey'>;

type RequestOptions = {
  body?: unknown;
  keepalive?: boolean;
  /** The user to send as, if not whoever is signed in now. */
  as?: SignedInUser;
  /** How long to wait for the answer, if less than usual. */
  timeoutMs?: number;
};

/** A request still unanswered after this is abandoned and treated as a network failure. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Transport for `/client/v1`: headers, timeouts and errors, sent as the signed-in user.
 * On a 401 it asks `identity` for a fresh token once and repeats the call.
 */
export class ClientApi {
  /** Undefined if `apiUrl` isn't an address: then every request fails with `urlProblem`. */
  private readonly baseUrl: string | undefined;
  private readonly clientKey: string;
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
    const host = url && /^https?:$/.test(url.protocol) ? url.host : undefined;
    if (host === undefined) {
      this.urlProblem = `apiUrl must be an address like ${DEFAULT_API_URL}`;
    } else {
      this.baseUrl = `${apiUrl.replace(/\/+$/, '')}/client/v1`;
    }
    // A malformed apiUrl still gets a namespace of its own, never a real workspace's.
    this.namespace = `${options.clientKey}@${host ?? apiUrl}`;
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
    if (this.baseUrl === undefined) throw new KiroraError(this.urlProblem!);
    const user = options.as ?? this.identity.user;
    if (!user) throw new KiroraError('call identify() with a user token first');
    const sentToken = user.token;
    const answer = await this.send(this.baseUrl, method, path, sentToken, options);
    if (answer !== REFUSED) return answer as Data | undefined;

    // Kirora refused the token: get a fresh one, once, and try again with it.
    const freshToken = await this.identity.refresh(user, sentToken);
    if (freshToken) {
      const retried = await this.send(this.baseUrl, method, path, freshToken, options);
      if (retried !== REFUSED) return retried as Data | undefined;
    }
    throw new KiroraApiError(401, undefined, 'Kirora answered 401');
  }

  /**
   * One call, answer and all: the timeout covers reading the body too, since a body that
   * stops arriving would otherwise hold the call open for good. Returns `REFUSED` for a
   * 401, so the caller can refresh the token.
   */
  private async send(
    baseUrl: string,
    method: string,
    path: string,
    userToken: string,
    options: RequestOptions,
  ): Promise<unknown> {
    const hasBody = options.body !== undefined;
    // AbortSignal.timeout() is newer than the browsers we support.
    const abort = new AbortController();
    const exchange = async () => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${userToken}`,
          'kirora-client-key': this.clientKey,
          'kirora-sdk': SDK_NAME,
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
        },
        body: hasBody ? JSON.stringify(options.body) : undefined,
        keepalive: options.keepalive,
        signal: abort.signal,
      });
      if (response.status === 401) {
        // Not read, so let the connection go.
        response.body?.cancel().catch(() => undefined);
        return REFUSED;
      }
      if (!response.ok) throw await toApiError(response);
      if (response.status === 204) return undefined;
      return ((await response.json()) as { data: unknown }).data;
    };
    try {
      return await withTimeout(exchange(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    } finally {
      // Lets go of the call if it timed out; does nothing once it's answered.
      abort.abort();
    }
  }
}

/** What `send()` returns for a 401. */
const REFUSED = Symbol();

async function toApiError(response: Response): Promise<KiroraApiError> {
  const body = (await response.json().catch(() => undefined)) as
    { error?: { code?: string; message?: string } } | undefined;
  return new KiroraApiError(
    response.status,
    body?.error?.code,
    body?.error?.message ?? `Kirora answered ${response.status}`,
    retryAfterMs(response.headers.get('retry-after')),
  );
}

/** `Retry-After` as seconds or an HTTP date (RFC 9110), in milliseconds from now. */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header?.trim()) return undefined;
  const seconds = Number(header);
  const delayMs = Number.isNaN(seconds)
    ? Date.parse(header) - Date.now()
    : seconds * 1000;
  return delayMs > 0 ? delayMs : undefined;
}
