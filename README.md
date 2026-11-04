# @kirora/web

The Kirora SDK for the browser. Track what your signed-in users do, record their consent,
and register their browsers to receive web push notifications from Kirora.

- Works on any site: React, Vue, Next.js, Webflow or plain HTML
- Zero runtime dependencies, with TypeScript types included
- Batches events and retries failed requests, with a bounded offline queue
- Supports Chrome 80, Firefox 74, Safari 14 and later

[Quickstart](#quickstart) · [Usage](#usage) · [Web push](#web-push) ·
[Frameworks](#frameworks) · [Script tag](#script-tag) · [API](#api) ·
[Troubleshooting](#troubleshooting)

## Installation

```sh
npm install @kirora/web
# or: pnpm add @kirora/web
# or: yarn add @kirora/web
```

Or load it from a CDN with a `<script>` tag (see [Script tag](#script-tag)).

## Quickstart

### 1. Get your keys

In the Kirora dashboard, go to **Developer → SDK**:

- The **client key** (`kirora_pk_…`) is public and goes in your page.
- The **token secret** is private. Keep it on your server, e.g. as
  `KIRORA_SDK_TOKEN_SECRET`.

### 2. Add a token route to your server

The SDK sends events as the user named in a signed token. Your server must derive that
user from your app's authenticated session, never from an ID supplied by the browser.
Keep the token secret out of client bundles and public environment variables.

For a Node.js server, install the token helper separately:

```sh
npm install @kirora/node
```

This Express example assumes your app already provides `app`, `requireSignedIn` and
`req.user.id`. The middleware must reject unauthenticated requests with `401`:

```ts
import { createUserToken } from '@kirora/node';

app.get(
  '/kirora-token',
  (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  },
  requireSignedIn,
  (req, res) => {
    const secret = process.env.KIRORA_SDK_TOKEN_SECRET;
    if (!secret) return res.sendStatus(500);
    res.type('text/plain').send(createUserToken(secret, String(req.user.id)));
  },
);
```

For Next.js App Router, use a server route. Replace `auth()` with your app's session
lookup (`@/auth` below is an application module):

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

In other languages, sign an HS256 JWT with the token secret. Set `sub` to your app's user
ID as a string, `iat` to the current Unix time in seconds, and `exp` to at most 24 hours
later. A one-hour lifetime is a useful starting point. Return plain text with
`Cache-Control: no-store`, including on error responses.

### 3. Create the client

Create one instance for your whole site. This example enables page views; sessions are
on by default. Push is configured separately in [Web push](#web-push).

If tracking requires opt-in, add `requireTrackingConsent: true` **when creating the
client**, before it can record sessions or page views. See [Tracking consent](#tracking-consent).

```ts
// kirora.ts
import { Kirora } from '@kirora/web';

export const kirora = new Kirora({
  clientKey: 'kirora_pk_…',
  fetchUserToken: async () => {
    const response = await fetch('/kirora-token', { cache: 'no-store' });
    // Throw on errors: the SDK keeps queued events and retries later.
    if (!response.ok) throw new Error(`Token request failed: ${response.status}`);
    return response.text();
  },
  trackPageViews: true, // optional
});
```

## Usage

### Identify users

Call `identify()` on every page load where the user is signed in, and right after they
sign in. Call `logout()` before your own sign-out, while the token route can still
authenticate the user.

```ts
try {
  await kirora.identify();
} catch (error) {
  console.error('Kirora identification failed', error);
}

kirora.track('Plan Upgraded', { plan: 'pro', seats: 5 });

// In your sign-out handler; signOut() is your app's own function.
try {
  await kirora.logout();
} catch (error) {
  console.error('Kirora logout failed', error);
} finally {
  await signOut();
}
```

`identify()` uses `fetchUserToken`, or you can pass a token you already have:
`identify(token)`. This argument is a signed token, not a user ID. Handle rejected
promises from `identify()`, `logout()` and push methods in your application.

Tokens stay in memory, so identification must run again after a reload. When a token is
refused, the SDK can call `fetchUserToken` to refresh it; a supplied token alone cannot
be refreshed automatically.

### Track events

```ts
kirora.track('Plan Upgraded', { plan: 'pro', seats: 5 });
kirora.track('Order Completed', { order_id: 'A-1001', total: 49.99, currency: 'GBP' });
```

`track()` returns immediately, so there's no need to `await` it. Events tracked before
sign-in are queued and attributed to the **next identified user**. Events recorded while
signed in remain bound to that user. Avoid sending secrets or sensitive personal data in
event properties; properties are not automatically redacted.

### Page views

Set `trackPageViews: true` to track `Page Viewed` on every page, including single-page app
navigations. Changes to the query string alone don't count as a new page. Or call
`kirora.trackPageView()` yourself, e.g. from your router.

### Sessions

A session starts with a `Session Started` event. Its properties record how the visitor
arrived (`path`, `referrer` and any `utm_*` tags). Every event includes the session in
`context.sessionId`. Sessions end after 30 minutes of inactivity and are shared across tabs
and subdomains. Set `trackSessions: false` to turn them off.

### Tracking consent

If your app requires tracking opt-in, set `requireTrackingConsent: true` in the client
options. Events, sessions and tracking device IDs are not recorded before consent;
pre-consent events are discarded rather than replayed later. Nothing is sent without
consent either: events already on the device (for example, from before you turned this
option on) wait until the visitor consents, and are deleted if they've refused.

Connect your existing consent UI to these calls (`cookieBanner` represents your app's
banner API):

```ts
cookieBanner.onAccept(() => kirora.setTrackingConsent(true));
cookieBanner.onReject(() => kirora.setTrackingConsent(false));
```

The answer is saved on the device. Withdrawing consent stops tracking, clears any queued
events and empties the session cookie on every subdomain. The device id cookie is
emptied too, unless this browser is registered for push. In that case it is retained
until `logout()` detaches the browser. This option gates tracking, not push
registration or API calls. The consent answer itself is stored locally.

Without `requireTrackingConsent`, tracking is on by default, but
`setTrackingConsent(false)` still turns it off on this device, until
`setTrackingConsent(true)`.

### Web push

Push is off by default. Use HTTPS in production and ask permission from a signed-in
user's click handler. Tracking consent, browser permission and marketing push consent
are separate settings.

1. Create a web push app in the Kirora dashboard.
2. Set `push: true` when creating the client. If your workspace has multiple web push
   apps, use `push: { pushAppId: 'your-push-app-id' }`.
3. Serve `kirora-sw.js` from your site's root. It must be on your own origin:

   ```sh
   cp node_modules/@kirora/web/dist/kirora-sw.js public/kirora-sw.js
   ```

   Repeat the copy when the SDK is updated, ideally as part of your app's build. The
   worker handles Kirora pushes and reports opens and clicks automatically.

   **If your site already has a service worker** (e.g. a PWA), a scope can only have one,
   so don't add a second. Serve `kirora-sw.js` next to yours, import it, and tell the SDK
   to use your worker:

   ```js
   // In your existing /sw.js (a classic worker, not a module worker):
   importScripts('/kirora-sw.js');
   ```

   Set `push: { serviceWorkerUrl: '/sw.js' }` on the client from the quickstart.

   For generated workers, configure the generator to import the script. `importScripts`
   requires a classic worker; it cannot be used in a module worker. The SDK refuses to
   replace a different worker and logs what to change.

4. Ask for permission from a click (browsers block the prompt otherwise):

   ```ts
   button.addEventListener('click', async () => {
     try {
       if ((await kirora.requestPushPermission()) === 'granted') {
         await kirora.setPushConsent(true);
       }
     } catch (error) {
       console.error('Could not enable notifications', error);
     }
   });
   ```

Browser permission and marketing consent are separate: `setPushConsent()` records whether
the user agreed to receive marketing pushes.

On iPhone and iPad, web push needs iOS 16.4 or later and only works once the site has been
added to the home screen. Otherwise, `requestPushPermission()` returns `unsupported`.

## Frameworks

### React

Create the client once, outside your components, and identify the user when your session
starts:

```tsx
import { useEffect } from 'react';
import { kirora } from './kirora';

export function KiroraSession({ userId }: { userId: string | null }) {
  useEffect(() => {
    if (userId) kirora.identify().catch((error) => console.error(error));
  }, [userId]);
  return null;
}
```

### Next.js

Use the client from client components (`'use client'`). Importing it during server
rendering is safe. Call SDK methods from the browser; on browser initialization, sessions
and optional page views can be queued before `identify()`.

See the [complete Next.js example](examples/nextjs) and [example setup instructions](examples/README.md)
for the token route, session component and sign-out handler. If push is enabled, put
`kirora-sw.js` in `public/`.

## Script tag

Without a bundler, add this snippet to your `<head>`. It queues calls until the SDK loads,
then replays them in order. Set your client key, provide the authenticated token route
from the quickstart, and pin the CDN URL to the SDK version you use.

<details>
<summary>CDN loader snippet</summary>

```html
<script>
  (function (options) {
    var kirora = (window.kirora = window.kirora || []);
    if (!Array.isArray(kirora) || kirora.options) return;
    // Record when and where each call was made.
    function held() {
      var canonical = document.querySelector('link[rel="canonical"]');
      return {
        at: Date.now(),
        href: location.href,
        title: document.title,
        canonical: canonical ? canonical.href : undefined,
      };
    }
    kirora.options = options;
    kirora.start = held();
    [
      'identify',
      'logout',
      'track',
      'trackPageView',
      'setPushConsent',
      'setTrackingConsent',
    ].forEach(function (method) {
      kirora[method] = function () {
        kirora.push([method, Array.prototype.slice.call(arguments), held()]);
      };
    });
    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://cdn.jsdelivr.net/npm/@kirora/web@0.1.0/dist/kirora.min.js';
    document.head.appendChild(script);
  })({
    clientKey: 'kirora_pk_…',
    trackPageViews: true,
    fetchUserToken: function () {
      return fetch('/kirora-token').then(function (response) {
        if (!response.ok) throw new Error('Token request failed: ' + response.status);
        return response.text();
      });
    },
  });

  // Call identify() only when your app knows the user is signed in.
  // kirora.identify();
  kirora.track('Signup Started');
</script>
```

The queued calls are replayed one at a time, each after the one before has finished, so
an event tracked after `identify()` or `logout()` belongs to the user that left signed in.
Calls made while they replay join the end of the queue. Then `window.kirora` becomes the
SDK instance. `requestPushPermission()` isn't queued because it must run during a click,
so call it after the SDK has loaded.

</details>

## Install with an AI coding agent

Paste this into your agent (Claude Code, Cursor, Copilot and so on):

```text
Install the Kirora web SDK in this app: add the @kirora/web package with this project's
package manager, then follow node_modules/@kirora/web/llms.txt step by step. Ask me for
the client key and token secret, and before setting up consent or web push.
```

The packaged [llms.txt](llms.txt) covers the integration steps and checks for common mistakes.

## API

### `new Kirora(options)`

| Option                   | Type                                                        | Default                               |
| ------------------------ | ----------------------------------------------------------- | ------------------------------------- |
| `clientKey`              | `string`                                                    | required                              |
| `fetchUserToken`         | `() => Promise<string>`                                     | omitted; pass a token to `identify()` |
| `trackPageViews`         | `boolean`                                                   | `false`                               |
| `trackSessions`          | `boolean`                                                   | `true`                                |
| `requireTrackingConsent` | `boolean`                                                   | `false`                               |
| `push`                   | `true \| { pushAppId?: string; serviceWorkerUrl?: string }` | disabled                              |
| `logLevel`               | `'none' \| 'error' \| 'debug'`                              | `'error'`                             |
| `apiUrl`                 | `string`                                                    | `https://api.kirora.io`               |

`apiUrl` is only for staging or a private deployment. Give the address without a path; the
SDK adds its own.

### Methods

| Method                        | Description                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `identify(token?)`            | Sets the user, starts sending queued events and registers for push if allowed                   |
| `logout()`                    | Tries to send queued events, detaches this browser from pushes, forgets the user                |
| `track(name, properties?)`    | Tracks an event                                                                                 |
| `trackPageView()`             | Tracks `Page Viewed` for the current page                                                       |
| `requestPushPermission()`     | Shows the browser prompt. Returns `granted`, `denied`, `unanswered` or `unsupported`            |
| `setPushConsent(granted)`     | Records consent to marketing pushes                                                             |
| `setTrackingConsent(granted)` | Records tracking consent. A refusal is honoured with or without `requireTrackingConsent`        |
| `flush()`                     | Tries to send queued events now. Some may wait for a retry. Rarely needed                       |
| `destroy()`                   | Stops timers, listeners and sending, e.g. on hot reload. Queued events stay for the next client |

### Errors

Every error the SDK throws is a `KiroraError`, so one `instanceof` check catches them all:

- `KiroraApiError` when Kirora refuses a call, with `status`, `code`, `retryAfterMs` and
  `retryable`.
- `UserTokenError` when `fetchUserToken` fails or doesn't answer within 30 seconds. During
  delivery it's logged instead, and queued events are retried later.

`track()` never throws: events Kirora refuses are logged, and so is an event without a
name or whose properties aren't an object, which isn't tracked.

## How it works

- **Batching.** Events are sent in batches: immediately once 20 are queued, otherwise every
  30 seconds, when the tab is hidden and when the browser comes back online.
- **Reliable delivery.** Up to 1,000 events (and 1 MB) are kept in `localStorage`, shared
  between tabs; past that, the oldest are dropped. Failed requests are retried with
  exponential backoff, never sooner than `Retry-After`. Each event has an idempotency key,
  so Kirora can deduplicate retries. An event is only removed once Kirora has answered
  for it; events it rejects outright are logged and dropped so they don't block the queue.
- **Users stay apart.** An event tracked while a user is signed in is only ever sent as
  that user, even if another signs in before it's sent. Events tracked before sign-in go
  as whoever signs in next. Each workspace's queue is kept separately.
- **If storage fails.** If `localStorage` is blocked or full, the SDK keeps events in memory
  instead and logs that once. They're still sent, but lost if the page reloads first.
- **Event context.** Each event includes a `context` alongside your properties: the page
  (`url`, `path`, `title`, `referrer`, using the canonical URL if the page has one), `utm_*`
  campaign tags, `locale`, `timezone`, `sessionId` and `device.id`. Kirora adds the IP
  address and user agent on the server.
- **Privacy.** Query strings (other than `utm_*` tags) and URL fragments are never sent,
  since they often contain tokens or email addresses.
- **Device id.** `device.id` and the session are stored in a first-party cookie on your
  root domain, so `www.` and `app.` subdomains are treated as the same visitor.
- **Clock skew.** Event times are corrected on the server for differences in the device's
  clock.

## What the SDK stores

SDK cookies and `localStorage` entries are first-party. Other scripts running on your
origin can read them. Tracking consent gates event, session and tracking device-ID
storage; its decision is stored independently, as are push registrations when enabled.
Initialization also briefly writes and removes `kirora:probe` to test storage availability.

| Where                                          | Name                                               | Holds                                                            | Removed                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `localStorage`                                 | `kirora:events:<client key>@<api host>`            | Events waiting to be sent, with their properties and context     | Once Kirora answers for them; the user's at `logout()`; all on consent withdrawal. Oldest dropped past 1,000 events or 1 MB |
| Cookie on your root domain, and `localStorage` | `kirora_session`, `kirora:session`                 | The session id and when it was last active                       | On consent withdrawal. A session ends after 30 minutes without activity                                                     |
| Cookie on your root domain, and `localStorage` | `kirora_installation_id`, `kirora:installation-id` | `device.id`: a random id for this browser                        | On consent withdrawal, unless the browser is registered for push: then at `logout()`                                        |
| `localStorage`                                 | `kirora:tracking-consent`                          | The visitor's tracking consent answer                            | Never; it's their answer                                                                                                    |
| `localStorage`                                 | `kirora:push-registration:<client key>@<api host>` | Who this browser was registered for, its push endpoint, and when | After successful push detachment at `logout()`                                                                              |
| The browser's push service                     | (the push subscription)                            | Where to deliver pushes                                          | If `logout()` can't reach Kirora; otherwise kept for the next user                                                          |
| Memory only                                    |                                                    | The user token                                                   | When the page closes, or at `logout()`                                                                                      |

The cookies are `SameSite=Lax`, `Secure` on HTTPS, and last a year; their value is the
same as the `localStorage` copy, which restores a cleared cookie. If `localStorage` is
unavailable or full, the SDK keeps these in memory for the page's life instead.

Several tabs share the queue. Browsers older than Firefox 96 and Safari 15.4 have no
Web Locks, so two tabs saving at the same instant can lose an event, and two tabs
can send the same event: Kirora drops the duplicate by its idempotency key.

## Content Security Policy

If your site sets a CSP, allow:

| Directive     | Allow                                                                                 |
| ------------- | ------------------------------------------------------------------------------------- |
| `connect-src` | `https://api.kirora.io`, or your `apiUrl`                                             |
| `script-src`  | `https://cdn.jsdelivr.net` if you load the SDK from the CDN; nothing if you bundle it |
| `worker-src`  | `'self'`, for `kirora-sw.js` (service workers are always same-origin)                 |

The script-tag snippet is inline, so it needs a `nonce` or a `sha256-` hash in
`script-src`; never `'unsafe-inline'`. Or put the snippet in a file on your own origin.

A service worker gets its own CSP from the headers it's served with. If you set one
there, its `connect-src` must allow Kirora's API too, which is where opens and clicks
are reported.

## Naming events

Segments, journeys and goals match event names exactly, so keep them consistent:

- Use an object followed by a past-tense action, in Title Case: `Plan Upgraded`,
  `Invoice Paid`, `Signup Started`.
- Name what the user did, not where: `Order Completed` with `{ "source": "checkout" }`,
  not `Checkout Page Button Clicked`.
- Put details in properties: `Plan Upgraded` with `{ "plan": "pro" }`, not
  `Pro Plan Upgraded`.
- Use the standard e-commerce names where they apply: `Product Viewed`, `Product Added`,
  `Order Completed` and so on.
- Names starting with `contact.` are reserved.

## Verify your integration

1. Request `/kirora-token` signed out: expect `401` and `Cache-Control: no-store`.
   Signed in, expect a plain-text JWT for the session user, with the same cache header.
2. Temporarily set `logLevel: 'debug'`, identify a signed-in user and track an event.
   Look for `Kirora: Sent … events` within 30 seconds or after switching tabs.
   Debug logs include event data; remove this setting after checking.
3. If consent is required, check that tracking is blocked before acceptance and that
   withdrawing consent clears the queue.
4. For push, check that your service worker URL serves JavaScript, then enable
   notifications from a click and send a test push from the dashboard.

## Troubleshooting

| Symptom                                     | Check                                                                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Events remain queued                        | Call `identify()` on each signed-in page load; check tracking consent, connectivity and the token route.                                            |
| Token request fails or Kirora returns `401` | Use the authenticated session's user ID, the correct workspace token secret and an unexpired token. Never use the public client key to sign tokens. |
| Events disappear on reload                  | Check browser storage restrictions and queue limits. In-memory fallback cannot persist across reloads.                                              |
| Notification permission is `unsupported`    | Enable `push`, use a supported browser and secure context, and check iOS home-screen requirements.                                                  |
| Push registration fails                     | Check the dashboard push app, the worker URL and existing worker registrations.                                                                     |
| CSP blocks requests or scripts              | Check [Content Security Policy](#content-security-policy), including headers served with the worker.                                                |

## Support and contributing

For integration help, email [support@kirora.io](mailto:support@kirora.io).
See [CONTRIBUTING.md](CONTRIBUTING.md) for bug reports and local development,
and [SECURITY.md](SECURITY.md) to report vulnerabilities privately.

## License

[MIT](LICENSE)
