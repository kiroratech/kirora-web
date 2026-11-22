# @kirora/web

The Kirora SDK for the browser. Track what your signed-in users do, record their consent,
and send them web push notifications from Kirora.

- Works on any site: React, Vue, Next.js, Webflow or plain HTML
- Zero runtime dependencies, with TypeScript types included
- Batches events and retries failed requests, with a bounded offline queue
- Supports Chrome 80, Firefox 74, Safari 14 and later

Events are sent as a **signed-in user**, named in a token your server signs. You'll need a
small token route on your server (step 2 below).

[Quickstart](#quickstart) · [Tracking](#tracking) · [Web push](#web-push) ·
[API](#api) · [Troubleshooting](#troubleshooting) · [Guides](#guides)

## Installation

```sh
npm install @kirora/web
# or: pnpm add @kirora/web
# or: yarn add @kirora/web
```

No bundler? Load it with a [script tag](docs/script-tag.md) instead.

## Quickstart

### 1. Get your keys

In the Kirora dashboard, go to **Developer → SDK**:

- The **client key** (`kirora_pk_…`), shown as **Public key**, goes in your page.
- The **SDK token secret**, shown as **Secret key**, stays on your server, e.g. as
  `KIRORA_SDK_TOKEN_SECRET`. Never put it, or your server API keys, in the page.

### 2. Add a token route to your server

The route answers with a token naming the signed-in user. Take the user from your app's
own authenticated session, never from anything the browser sends: whoever the token names
gets the events.

With Node.js, install the token helper (`npm install @kirora/node`). This Next.js App
Router route assumes `auth()` is your app's session lookup:

```ts
// app/kirora-token/route.ts
import { createUserToken } from '@kirora/node';
import { auth } from '@/auth';

const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' };

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return new Response(null, { status: 401, headers });
  const secret = process.env.KIRORA_SDK_TOKEN_SECRET;
  if (!secret) return new Response(null, { status: 500, headers });
  return new Response(createUserToken(secret, String(session.user.id)), { headers });
}
```

Express and other frameworks: the same logic in a `GET` handler behind your auth
middleware ([Express example](docs/authentication.md#express-token-route)). In other
languages, sign an HS256 JWT with the SDK token secret: `sub` is your user ID as a string,
`iat` the current Unix time, and `exp` at most 24 hours later (one hour is usual). Always
answer with `Cache-Control: no-store`.

Kirora keeps each user as a **contact** whose `externalId` is the token's `sub`. Use the
same ID you use with Kirora's server API, or one person becomes two contacts.

### 3. Create the client

Create one client for your whole site, in a module of its own:

```ts
// kirora.ts
import { Kirora } from '@kirora/web';

export const kirora = new Kirora({
  clientKey: 'kirora_pk_…',
  fetchUserToken: async () => {
    const response = await fetch('/kirora-token', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Token request failed: ${response.status}`);
    return response.text();
  },
  trackPageViews: true, // optional
  // requireTrackingConsent: true, // if tracking needs opt-in: see Tracking consent
});
```

### 4. Identify the user, track, and sign out

Call `identify()` on every page load where the user is signed in (tokens live in memory
only), and right after they sign in. If it rejects, events stay queued until it succeeds,
so try again later, e.g. on the next page load.

```ts
try {
  await kirora.identify();
} catch (error) {
  console.error('Kirora identification failed', error);
}

kirora.track('Plan Upgraded', { plan: 'pro', seats: 5 });
```

When the user signs out, call `logout()` **before** your own sign-out, while the token
route still knows them. It never rejects and is done within 5 seconds:

```ts
await kirora.logout();
await signOut(); // your app's own sign-out
```

### 5. Check it works

1. Request `/kirora-token` signed out: expect `401` with `Cache-Control: no-store`. Signed
   in: a plain-text JWT for that user, with the same header.
2. Set `logLevel: 'debug'`, sign in and track an event. Within 30 seconds (or on switching
   tabs) the console shows `Kirora: Sent … events`. Remove the setting afterwards.
3. The event appears on the contact in the Kirora dashboard.

### React and Next.js

Create the client once, outside components, and identify when your session starts. In
Next.js, call the SDK from client components; importing it during server rendering is
safe.

```tsx
'use client';
import { useEffect } from 'react';
import { kirora } from './kirora';

// Render it once, near the root, with your session's user id (null when signed out).
export function KiroraSession({ userId }: { userId: string | null }) {
  useEffect(() => {
    if (userId) kirora.identify().catch((error) => console.error(error));
  }, [userId]);
  return null;
}
```

Sign-out still calls `logout()` from your handler, as above. See the
[complete Next.js example](examples/nextjs).

## Tracking

```ts
kirora.track('Order Completed', { order_id: 'A-1001', total: 49.99, currency: 'GBP' });
```

- `track()` returns at once and never throws. Properties are copied when it's called and
  must be JSON; an event that can't be is dropped and logged.
- Nothing is sent for a visitor who never signs in. Events tracked before sign-in wait,
  and go as the next user to sign in. Events tracked while someone is signed in only ever
  go as them.
- Name events as an object and a past-tense action, in Title Case (`Plan Upgraded`), and
  put details in properties. Segments and journeys match names exactly.
- Every event counts against your plan's monthly event allowance, including the automatic
  `Session Started` and `Page Viewed`.

**Sessions** are on by default: a `Session Started` event records how the visitor arrived,
and each event carries `context.sessionId`. A session ends after 30 minutes with no
events and no visible tab, and at `logout()`. Turn them off with `trackSessions: false`.

**Page views**: `trackPageViews: true` tracks `Page Viewed` on every page, single-page app
navigations included; or call `trackPageView()` from your router.

**Privacy**: page addresses are collected with their query strings. If yours can carry a
token or personal data (a password reset link, `?email=`), remove it with
[`beforeSend`](docs/tracking.md#redacting-events), which can change or drop any event
before it's stored.

### Tracking consent

If tracking needs opt-in, set `requireTrackingConsent: true` when creating the client, and
connect your consent banner:

```ts
cookieBanner.onAccept(() => kirora.setTrackingConsent(true));
cookieBanner.onReject(() => kirora.setTrackingConsent(false));
```

Before consent, nothing is tracked or stored, and events from then are discarded, not
replayed. Withdrawing consent stops tracking and clears queued events and the session.
Without the option, tracking is on by default, but `setTrackingConsent(false)` still
turns it off. Consent covers tracking only, not push.

More in the [tracking guide](docs/tracking.md): event rules and limits, redaction,
sessions, consent in detail, and how Kirora uses your events.

## Web push

Push is off by default. It needs HTTPS and a signed-in user.

1. Create a web push app in the Kirora dashboard.
2. Set `push: true` on the client (or `push: { pushAppId: '…' }` if your workspace has
   several web push apps).
3. Serve `kirora-sw.js` from your site's root, and copy it again on each SDK update,
   ideally in your build:

   ```sh
   cp node_modules/@kirora/web/dist/kirora-sw.js public/kirora-sw.js
   ```

   **Already have a service worker** (e.g. a PWA)? Don't add a second: import Kirora's
   into yours. See [using your own service worker](docs/push.md#your-own-service-worker).

4. Ask for permission from a click, as browsers block the prompt otherwise:

   ```ts
   button.addEventListener('click', async () => {
     try {
       if ((await kirora.requestPushPermission()) === 'granted') {
         // Only if this button asked to receive marketing notifications:
         await kirora.setPushConsent(true);
       }
     } catch (error) {
       console.error('Could not enable notifications', error);
     }
   });
   ```

Browser permission and marketing consent are separate: `setPushConsent()` records whether
the user agreed to marketing pushes; transactional pushes need only the permission. For an
on/off setting, use `getPushStatus()` and `setPushEnabled()`. A tap opens the push's link;
to route it yourself, use `addNotificationClickListener()`. On iPhone and iPad, web push
needs iOS 16.4 or later and a site added to the Home Screen.

More in the [push guide](docs/push.md).

## API

### `new Kirora(options)`

| Option                   | Type                                                        | Default                               |
| ------------------------ | ----------------------------------------------------------- | ------------------------------------- |
| `clientKey`              | `string`                                                    | required                              |
| `fetchUserToken`         | `() => Promise<string \| null \| undefined>`                | omitted; pass a token to `identify()` |
| `trackPageViews`         | `boolean`                                                   | `false`                               |
| `trackSessions`          | `boolean`                                                   | `true`                                |
| `requireTrackingConsent` | `boolean`                                                   | `false`                               |
| `push`                   | `true \| { pushAppId?: string; serviceWorkerUrl?: string }` | disabled                              |
| `logLevel`               | `'none' \| 'error' \| 'debug'`                              | `'error'`                             |
| `apiUrl`                 | `string`                                                    | `https://api.kirora.io`               |
| `beforeSend`             | `(event) => event \| null`                                  | none: events are sent as collected    |
| `onAuthenticationFailed` | `(reason: 'fetch_failed' \| 'refused') => void`             | none                                  |

`apiUrl` is only for staging or a private deployment. `onAuthenticationFailed` tells you
when the user's token fails in the background, where no method call would
([details](docs/authentication.md#when-the-token-fails)).

### Methods

| Method                                      | Returns                   | Description                                                                         |
| ------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| `identify(token?)`                          | `Promise<void>`           | Signs the user in, sends their events and registers for push if allowed. Can reject |
| `logout()`                                  | `Promise<void>`           | Sends queued events, detaches push and forgets the user, within 5 s. Never rejects  |
| `track(name, properties?)`                  | `void`                    | Tracks an event. Never throws                                                       |
| `trackPageView()`                           | `void`                    | Tracks `Page Viewed` for the current page                                           |
| `setTrackingConsent(granted)`               | `void`                    | Records tracking consent; a refusal holds with or without `requireTrackingConsent`  |
| `requestPushPermission()`                   | `Promise<PushPermission>` | Shows the prompt: `granted`, `denied`, `unanswered` or `unsupported`                |
| `getPushStatus()`                           | `Promise<PushStatus>`     | `enabled`, `disabled`, `denied`, `unanswered` or `unsupported`. Never prompts       |
| `setPushEnabled(enabled)`                   | `Promise<void>`           | This browser's push on or off, for whoever signs in. Never rejects                  |
| `setPushConsent(granted)`                   | `Promise<void>`           | Records consent to marketing pushes. Rejects if Kirora didn't record it             |
| `addNotificationClickListener(listener)`    | `void`                    | Hears taps on Kirora pushes, with the push's `data`                                 |
| `removeNotificationClickListener(listener)` | `void`                    | Stops a listener hearing taps                                                       |
| `flush()`                                   | `Promise<void>`           | Tries to send queued events now. Rarely needed                                      |
| `destroy()`                                 | `void`                    | Stops timers, listeners and sending, e.g. on hot reload                             |

### Errors

The SDK's errors are `KiroraError`s, so one `instanceof` check catches them:

- `KiroraApiError` when Kirora refuses a call, with `status`, `code`, `retryAfterMs` and
  `retryable`.
- `UserTokenError` when `fetchUserToken` throws, answers no token, or takes over 30
  seconds.
- `KiroraError` for a setup problem or a call that couldn't reach Kirora, with the cause.

`requestPushPermission()` can also reject with the browser's own error from its prompt.
More in [authentication and errors](docs/authentication.md#errors).

## Troubleshooting

| Symptom                                     | Check                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Events stay queued                          | `identify()` is called on each signed-in page load and resolves; tracking consent; the token route.         |
| Token request fails or Kirora returns `401` | The token names the session's user, is signed with this workspace's SDK token secret, and hasn't expired.   |
| Events disappear on reload                  | Browser storage restrictions (private windows) and the queue's limit of 1,000 events.                       |
| Push permission is `unsupported`            | `push` is set, the page is on HTTPS, the browser supports push, and on iOS the site is on the Home Screen.  |
| Push registration fails                     | The push app in the dashboard, the worker URL serving JavaScript, and any other service worker on the site. |
| Content Security Policy blocks the SDK      | [CSP settings](docs/reference.md#content-security-policy), including headers served with the worker.        |

## Guides

- [Authentication](docs/authentication.md): identify, logout, token refresh, failures and
  errors
- [Tracking](docs/tracking.md): events, redaction, page views, sessions, consent, and how
  Kirora uses events
- [Web push](docs/push.md): your own service worker, on/off settings, taps
- [Script tag](docs/script-tag.md): using the SDK without a bundler
- [Reference](docs/reference.md): delivery, what the SDK stores, CSP, and how web differs
  from the mobile SDKs
- [llms.txt](llms.txt): step-by-step instructions for AI coding agents. Paste this into
  yours: _Install the Kirora web SDK in this app: add the @kirora/web package, then follow
  node_modules/@kirora/web/llms.txt step by step. Ask me for the client key and SDK token
  secret, and before setting up consent or web push._

## Support and contributing

For integration help, email [support@kirora.io](mailto:support@kirora.io). See
[CONTRIBUTING.md](CONTRIBUTING.md) for bug reports and local development, and
[SECURITY.md](SECURITY.md) to report vulnerabilities privately.

## License

[MIT](LICENSE)
