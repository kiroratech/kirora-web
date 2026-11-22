import { vi } from 'vitest';
import { Kirora, type KiroraOptions } from '../src/index.js';

/** An event as `POST /events/batch` carries it. */
type SentEvent = {
  name: string;
  properties: Record<string, unknown>;
  context: { sessionId?: string; device: { id: string }; page?: { url: string } };
};

/**
 * Kirora's answer to `POST /events/batch` when it accepts every event: one receipt each,
 * as Kirora writes it.
 */
export function accepted(batch: BodyInit | null | undefined | { events: unknown[] }) {
  const { events } = (typeof batch === 'string' ? JSON.parse(batch) : batch) as {
    events: { idempotencyKey: string }[];
  };
  return Response.json({
    data: {
      results: events.map(({ idempotencyKey }) => ({
        idempotencyKey,
        replayed: false,
        event: { idempotencyKey },
      })),
    },
  });
}

/** Stubs `fetch` with a Kirora that accepts every event. Returns the events, in order. */
export function recordEvents(): SentEvent[] {
  const sent: SentEvent[] = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    const batch = JSON.parse(String(init.body)) as { events: SentEvent[] };
    sent.push(...batch.events);
    return Promise.resolve(accepted(batch));
  });
  return sent;
}

/** An event as Kirora received it, with the user it was sent as. */
export type SentAs = { user: string | undefined; name: string; sessionId?: string };

/**
 * Stubs `fetch` with a Kirora that accepts every event, unless `answer` answers a call
 * first: a refusal, say, or a network failure. Returns the events accepted, in order,
 * with who each was sent as.
 */
export function recordSends(
  answer?: (url: string, init: RequestInit) => Promise<Response> | undefined,
): SentAs[] {
  const sent: SentAs[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const answered = answer?.(url, init);
    if (answered) {
      return answered;
    }
    const batch = JSON.parse(String(init.body)) as { events: SentEvent[] };
    const user = userOf(init);
    for (const { name, context } of batch.events) {
      sent.push({ user, name, sessionId: context.sessionId });
    }
    return Promise.resolve(accepted(batch));
  });
  return sent;
}

/** A Map-backed `Storage`. While `full()` is true, writes throw as a full quota does. */
export function memoryStorage(full = () => false) {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (full()) {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      values.set(key, value);
    },
    removeItem: (key: string) => void values.delete(key),
  };
}

/** Stubs `localStorage`, shared by every client in a test as one browser's is. */
export function stubLocalStorage(full?: () => boolean): void {
  vi.stubGlobal('localStorage', memoryStorage(full));
}

/**
 * A user token Kirora would accept, as far as the SDK can tell: a JWT naming `sub`, with
 * any other `claims`.
 */
export function tokenFor(sub: string, variant = '', claims: object = {}): string {
  const encoded = btoa(JSON.stringify({ sub, ...claims })).replace(/=+$/, '');
  return `header.${encoded}.signature${variant}`;
}

/**
 * Stubs `fetch` with a Kirora that refuses the tokens `refuses` names, with a 401, and
 * accepts every event otherwise. Returns the tokens each call was sent with, in order.
 */
export function kiroraRefusing(refuses: (token: string) => boolean): string[] {
  const tokens: string[] = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    const token = new Headers(init.headers).get('authorization')!.slice('Bearer '.length);
    tokens.push(token);
    return Promise.resolve(
      refuses(token) ? new Response(null, { status: 401 }) : accepted(init.body),
    );
  });
  return tokens;
}

/** The user a request was sent as: the `sub` of its token, as made by `tokenFor`. */
export function userOf(init: RequestInit): string | undefined {
  const claims = new Headers(init.headers).get('authorization')?.split('.')[1];
  return claims ? (JSON.parse(atob(claims)) as { sub: string }).sub : undefined;
}

/**
 * Stubs a browser where push is supported and permission granted: `location`, a service
 * worker already active, and its push manager. Until `subscribing` resolves, subscribing
 * waits, so a test can hold a registration there.
 */
export function stubWebPush(subscribing: Promise<void> = Promise.resolve()) {
  type Subscription = {
    endpoint: string;
    options: { applicationServerKey: ArrayBuffer };
    toJSON(): PushSubscriptionJSON;
    unsubscribe(): Promise<boolean>;
  };
  let current: Subscription | null = null;
  const registration = {
    scope: 'https://example.com/',
    active: { scriptURL: 'https://example.com/kirora-sw.js' },
    pushManager: {
      getSubscription: () => Promise.resolve(current),
      subscribe: async ({
        applicationServerKey,
      }: {
        applicationServerKey: Uint8Array;
      }) => {
        await subscribing;
        const endpoint = 'https://push.example.com/subscription';
        current = {
          endpoint,
          options: { applicationServerKey: applicationServerKey.slice().buffer },
          toJSON: () => ({ endpoint, keys: { p256dh: 'p256dh', auth: 'auth' } }),
          unsubscribe: () => {
            current = null;
            return Promise.resolve(true);
          },
        };
        return current;
      },
    },
  };
  vi.stubGlobal('location', new URL('https://example.com/'));
  vi.stubGlobal('navigator', {
    language: 'en',
    serviceWorker: {
      getRegistration: () => Promise.resolve(registration),
      register: () => Promise.resolve(registration),
    },
  });
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', { permission: 'granted' });
}

/** The VAPID public key of the fake Kirora's push app, base64url: the bytes 1, 2, 3. */
export const PUSH_APP_KEY = 'AQID';

/** A request the fake Kirora below was sent. */
export type SentRequest = {
  method: string;
  path: string;
  user: string | undefined;
  /** The `Authorization` header as sent: `Bearer <token>` or `Device <secret>`. */
  authorization: string | null;
  /** The query string, with its `?`, or empty. */
  search: string;
  body?: unknown;
};

/**
 * Stubs `fetch` with a Kirora that answers every call: events accepted, a push app, a
 * device registration with its `lastSeenAt` (`registrationAnswer` can replace it), and
 * 204 otherwise. Calls `hold` picks wait until `release()`. `requests` are in the order
 * they were sent, `handled` in the order Kirora acted on them, which a held call changes.
 */
export function fakeKirora(
  hold: (request: SentRequest) => boolean = () => false,
  registrationAnswer?: (request: SentRequest) => Response | undefined,
) {
  let registrations = 0;
  const requests: SentRequest[] = [];
  const handled: SentRequest[] = [];
  const held: (() => void)[] = [];
  const server = {
    requests,
    handled,
    held,
    /** Answers every held call. */
    release: () => held.splice(0).forEach((answer) => answer()),
    /**
     * Set to answer a call before the usual answers (a refusal, or a rejection for a
     * network failure); undefined lets the usual answer through. Recorded as handled.
     */
    answerFirst: undefined as
      ((request: SentRequest) => Promise<Response> | undefined) | undefined,
  };
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const request: SentRequest = {
      method: init.method ?? 'GET',
      path: new URL(url).pathname.replace('/client/v1', ''),
      user: userOf(init),
      authorization: new Headers(init.headers).get('authorization'),
      search: new URL(url).search,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(request);
    const first = server.answerFirst?.(request);
    if (first) {
      handled.push(request);
      return first;
    }
    const answer = () => {
      handled.push(request);
      if (request.path === '/events/batch') {
        return accepted(init.body);
      }
      if (request.path === '/push-app') {
        return Response.json({
          data: { pushAppId: 'app_web', name: 'Web', vapidPublicKey: PUSH_APP_KEY },
        });
      }
      if (request.method === 'PUT' && request.path.startsWith('/devices/')) {
        registrations += 1;
        const lastSeenAt = new Date(Date.UTC(2026, 10, 1, 0, 0, registrations));
        return (
          registrationAnswer?.(request) ??
          Response.json({
            data: {
              lastSeenAt: lastSeenAt.toISOString(),
              deviceSecret: `secret-${registrations}`,
            },
          })
        );
      }
      return new Response(null, { status: 204 });
    };
    if (!hold(request)) {
      return Promise.resolve(answer());
    }
    return new Promise<Response>((resolve) => held.push(() => resolve(answer())));
  });
  return server;
}

/** A client with push on and sessions off, logging nothing: what push tests start from. */
export function pushClient(options: Partial<KiroraOptions> = {}) {
  return new Kirora({
    clientKey: 'kirora_pk_a',
    trackSessions: false,
    push: true,
    logLevel: 'none',
    ...options,
  });
}

/** Each event sent to `fakeKirora()`, with the user it was sent as. */
export function sentEvents(requests: SentRequest[]) {
  return requests
    .filter((request) => request.path === '/events/batch')
    .flatMap((request) =>
      (
        request.body as { events: (SentEvent & { context: { sessionId?: string } })[] }
      ).events.map((event) => ({
        user: request.user,
        name: event.name,
        sessionId: event.context.sessionId,
      })),
    );
}
