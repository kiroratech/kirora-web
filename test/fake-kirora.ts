import { vi } from 'vitest';

/** An event as `POST /events/batch` carries it. */
type SentEvent = {
  name: string;
  properties: Record<string, unknown>;
  context: { sessionId?: string; device: { id: string }; page?: { url: string } };
};

/** Kirora's answer to `POST /events/batch` when it accepts every event: one result each. */
export function accepted(batch: BodyInit | null | undefined | { events: unknown[] }) {
  const { events } = (typeof batch === 'string' ? JSON.parse(batch) : batch) as {
    events: { idempotencyKey: string }[];
  };
  return Response.json({
    data: { results: events.map(({ idempotencyKey }) => ({ idempotencyKey })) },
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

/** A Map-backed `Storage`. While `full()` is true, writes throw as a full quota does. */
export function memoryStorage(full = () => false) {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (full()) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      values.set(key, value);
    },
    removeItem: (key: string) => void values.delete(key),
  };
}

/** Stubs `localStorage`, shared by every client in a test as one browser's is. */
export function stubLocalStorage(full?: () => boolean): void {
  vi.stubGlobal('localStorage', memoryStorage(full));
}

/** A user token Kirora would accept, as far as the SDK can tell: a JWT naming `sub`. */
export function tokenFor(sub: string, variant = ''): string {
  const claims = btoa(JSON.stringify({ sub })).replace(/=+$/, '');
  return `header.${claims}.signature${variant}`;
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
  body?: unknown;
};

/**
 * Stubs `fetch` with a Kirora that answers every call: events accepted, a push app, and
 * 204 otherwise. Calls `hold` picks wait until `release()`. `requests` are in the order
 * they were sent, `handled` in the order Kirora acted on them, which a held call changes.
 */
export function fakeKirora(hold: (request: SentRequest) => boolean = () => false) {
  const requests: SentRequest[] = [];
  const handled: SentRequest[] = [];
  const held: (() => void)[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const request: SentRequest = {
      method: init.method ?? 'GET',
      path: new URL(url).pathname.replace('/client/v1', ''),
      user: userOf(init),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(request);
    const answer = () => {
      handled.push(request);
      if (request.path === '/events/batch') return accepted(init.body);
      if (request.path === '/push-app') {
        return Response.json({
          data: { pushAppId: 'app_web', name: 'Web', vapidPublicKey: PUSH_APP_KEY },
        });
      }
      return new Response(null, { status: 204 });
    };
    if (!hold(request)) return Promise.resolve(answer());
    return new Promise<Response>((resolve) => held.push(() => resolve(answer())));
  });
  return {
    requests,
    handled,
    held,
    /** Answers every held call. */
    release: () => held.splice(0).forEach((answer) => answer()),
  };
}
