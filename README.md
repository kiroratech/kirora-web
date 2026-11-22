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

- The **client key** (`kirora_pk_…`), shown as **Public key**, is public and goes in your
  page.
- The **SDK token secret**, shown as **Secret key**, is private. Keep it on your server,
  e.g. as `KIRORA_SDK_TOKEN_SECRET`.

Your workspace's server API keys (for `/v1`) never go in the page either: the SDK only
needs the client key, and a user token your server signs.

### 2. Add a token route to your server

The SDK sends events as the user named in a signed token. Your server must derive that
user from your app's authenticated session, never from an ID supplied by the browser.
Keep the SDK token secret out of client bundles and public environment variables.

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

In other languages, sign an HS256 JWT with the SDK token secret. Set `sub` to your app's
user ID as a string, `iat` to the current Unix time in seconds, and `exp` to at most 24
hours later. A one-hour lifetime is a useful starting point. Return plain text with
`Cache-Control: no-store`, including on error responses.

Kirora keeps each signed-in user as a **contact**, whose `externalId` is the token's `sub`;
it creates the contact on the first call with a new `sub`. Use the same ID you give that
contact through Kirora's server API, or the same person becomes two contacts. Kirora
refuses a token whose `iat` is more than a minute ahead of its own clock.

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
await kirora.logout();
await signOut();
```

`identify()` uses `fetchUserToken`, or you can pass a token you already have:
`identify(token)`. This argument is a signed token, not a user ID. Handle rejected
promises from `identify()` and the push methods that can reject in your application.

`logout()` never rejects and returns within 5 seconds, whatever the network does. In that
time it tries, side by side, to send the user's queued events and detach this browser
from their pushes; then it forgets the user and anything of theirs still unsent. Events
tracked while it runs go to whoever signs in next. If Kirora can't
be told, the SDK cancels the browser's push subscription and keeps retrying the
detachment in the background (for up to a day) while the page stays open. A late retry
never undoes a newer sign-in: it names the registration it's detaching, so if the same
user signs in again meanwhile, in any tab, Kirora keeps their new registration, and if
someone else has signed in, it leaves theirs alone. Those retries live in memory only: if
the browser is offline at sign-out and the page closes, Kirora isn't told until the device
is registered again, so sign-out can't promise the server stops pushes at once. The
cancelled subscription stops them on this browser.

Tokens stay in memory, so identification must run again after a reload. With
`fetchUserToken`, the SDK asks for a fresh token a minute before the current one's `exp`,
as the tab is shown again past that time, and when Kirora refuses a token; a supplied
token alone cannot be refreshed. If that early refresh fails, it's tried again every 15
seconds until the current token expires. A token `identify()` signs in with that has
under a minute left is replaced at once; one a refresh gives with under a minute left is
used until Kirora refuses it. On a device whose clock is ahead, a token looks expired as
it arrives; its lifetime (`exp` less `iat`) is then counted from its arrival instead.
Requests wait for a refresh under way, so they don't go with the token it replaces.

Once Kirora refuses a token that can't be replaced (there's no `fetchUserToken`), the SDK
stops sending until `identify()` is called again, keeping the events, and every other
call as that user, such as `setPushConsent()`, rejects at once with a 401
`KiroraApiError` without asking Kirora again.

To hear when the user's token fails in the background, where no method call would tell
you, pass `onAuthenticationFailed`. It's called with `fetch_failed` (`fetchUserToken`
threw, answered no token or timed out) or `refused` (Kirora refused the token and no
fresh one was accepted), once per failure until a request with the user's token succeeds
or `identify()` is called. A failed early refresh is retried, and reported only if a refresh
still fails once the token has expired or Kirora has refused it. It's called on its own,
apart from the SDK's work, and only if that user is still signed in then: never after
`destroy()`, after another user has signed in, or during `logout()`. It isn't called for
an error a method rejects with:

```ts
const kirora = new Kirora({
  clientKey: 'kirora_pk_…',
  fetchUserToken,
  onAuthenticationFailed: (reason) => showSignInAgain(reason),
});
```

### Track events

```ts
kirora.track('Plan Upgraded', { plan: 'pro', seats: 5 });
kirora.track('Order Completed', { order_id: 'A-1001', total: 49.99, currency: 'GBP' });
```

`track()` returns immediately, so there's no need to `await` it. Nothing is sent for a
visitor who never signs in: Kirora has no anonymous contacts. Events tracked before
sign-in are queued and attributed to the **next signed-in user**, who adopts them as they
sign in. Events recorded while signed in remain bound to that user.

Every event the SDK sends counts against your plan's monthly event allowance (1,000 on
Free), including the automatic `Session Started` and `Page Viewed`; past it, Kirora
refuses events with `PLAN_LIMIT_REACHED`. An event that reaches Kirora more than 72 hours
after it happened (one queued while offline, say) starts no journey, though it still
counts for segments, journey exits and waits; one older than your plan keeps events (30
days on Free) is refused. Properties are
copied as they are when `track()` is called, and must be JSON: an event holding something
JSON can't (a function, `NaN`, a `Map`, a circular reference) is dropped and logged.
Dates are sent as ISO strings, and members that are `undefined` are left out. Avoid
sending secrets or sensitive personal data in event properties; use `beforeSend` (below)
to redact what you can't avoid.

### Redacting events

`beforeSend` is called once for every event, including `Session Started` and automatic
page views, before it's stored or sent. It gets a copy of `{ name, properties, context }`
and returns it with fields changed or removed, or `null` to drop the event. It must answer
at once: an error, a promise, or values JSON can't hold drop the event, and only the
kind of failure is logged, never the event. The event's name, time and idempotency key
stay the SDK's. Calling `track()` from inside it is refused. Change or remove what's in
`context`, but don't add fields to it: Kirora accepts only the fields it defines there,
and refuses an event with any other.

A page address can appear in several places, so redact every copy:

```ts
const kirora = new Kirora({
  clientKey: 'kirora_pk_…',
  beforeSend: (event) => {
    const clean = (value: unknown) =>
      typeof value === 'string' ? value.replace(/([?&]token=)[^&#]*/g, '$1') : value;
    const page = event.context.page as Record<string, unknown> | undefined;
    if (page)
      for (const key of ['url', 'search', 'referrer']) page[key] = clean(page[key]);
    for (const key of Object.keys(event.properties)) {
      event.properties[key] = clean(event.properties[key]);
    }
    return event;
  },
});
```

That covers `context.page` (`url`, `search`, `referrer`), `Page Viewed`'s copy of the page
in its properties, and `Session Started`'s landing `path` and `referrer`. Without a hook,
addresses are collected with their query strings, unchanged.

### Page views

Set `trackPageViews: true` to track `Page Viewed` on every page, including single-page app
navigations. Changes to the query string alone don't count as a new page. Or call
`kirora.trackPageView()` yourself, e.g. from your router.

Pages are recorded as Segment's analytics.js records them: the full address with its
query string (`url`, `path`, `search`, `title`, `referrer`). Nothing in it is masked, so if
a page's address carries a token or personal data (a password reset or magic link, an
`?email=`), redact it with [`beforeSend`](#redacting-events), or remove it from the
address before the SDK tracks the page:

```ts
const url = new URL(location.href);
url.searchParams.delete('token');
history.replaceState(history.state, '', url);
```

With the script tag, the loader snippet records the address as soon as it runs, so do this
in a script placed before the snippet. Removing the token also keeps it out of the next
page's `referrer`. Other sites' addresses usually arrive without their query string, since
browsers send other sites only the origin by default.

### Sessions

A session starts with a `Session Started` event. Its properties record how the visitor
arrived (`path`, `referrer` and any `utm_*` tags, as properties a segment or journey can
filter on). Every event includes the session in
`context.sessionId`. Sessions end after 30 minutes of inactivity, and at `logout()`.
Each signed-in user has their own session, shared across tabs and subdomains, so two tabs
signed in as different users each keep theirs. A visit begun before sign-in becomes the
session of whoever signs in. A reload continues the visit in progress until `identify()`
runs again; if someone else signs in then, the events from before sign-in go to them
without the earlier user's session, so the two visits are never joined. Set
`trackSessions: false` to turn sessions off.

### Tracking consent

If your app requires tracking opt-in, set `requireTrackingConsent: true` in the client
options. Events, sessions and tracking device IDs are not recorded before consent;
pre-consent events are discarded rather than replayed later, and consenting doesn't
track a page view for the page already open: collection starts from that moment. Nothing
is sent without
consent either: events already on the device (for example, from before you turned this
option on) wait until the visitor consents, and are deleted if they've refused.

Connect your existing consent UI to these calls (`cookieBanner` represents your app's
banner API):

```ts
cookieBanner.onAccept(() => kirora.setTrackingConsent(true));
cookieBanner.onReject(() => kirora.setTrackingConsent(false));
```

The answer is saved on the device, per workspace, and a refusal is saved twice, under
two keys, so losing or garbling one can't lose it. If the saved answer can't be understood
and no refusal is on record, the SDK logs it and treats the visitor as new: without
`requireTrackingConsent` it tracks, and with it, nothing is tracked until
`setTrackingConsent()` answers again. If `localStorage` can't be read at all (some privacy
modes block it), the SDK can't tell whether the visitor refused before, so it tracks
nothing until `setTrackingConsent(true)` is called on this page, even without
`requireTrackingConsent`, and logs that the answer can't be saved. Withdrawing consent
stops tracking, cancels a send under way, clears any queued events and empties the
session cookie on every subdomain. The device id cookie is
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
   # Yarn Plug'n'Play, which has no node_modules:
   cp "$(node -p "require.resolve('@kirora/web/kirora-sw.js')")" public/kirora-sw.js
   ```

   Repeat the copy when the SDK is updated, ideally as part of your app's build. The
   worker handles Kirora pushes and reports when they're shown, opened and clicked,
   automatically. When the browser replaces a push subscription, which it can do at any
   time, the worker tells Kirora, so the browser keeps receiving pushes without a visit.

   **If your site already has a service worker** (e.g. a PWA), a scope can only have one,
   so don't add a second. Serve `kirora-sw.js` next to yours, import it, and tell the SDK
   to use your worker:

   ```js
   // In your existing /sw.js (a classic worker, not a module worker):
   importScripts('/kirora-sw.js');
   ```

   Set `push: { serviceWorkerUrl: '/sw.js' }` on the client from the quickstart.

   Kirora's listeners then run beside yours. If your own `push` or `notificationclick`
   handlers show or open something for every event, have them skip Kirora's, or a push
   shows twice and a tap opens two windows:

   ```js
   const isKiroras = (event) => {
     try {
       return event.data?.json().kirora === 'true';
     } catch {
       return false; // not JSON, so not Kirora's
     }
   };
   self.addEventListener('push', (event) => {
     if (isKiroras(event)) return; // Kirora's: shown by kirora-sw.js
     // …your own handling
   });
   self.addEventListener('notificationclick', (event) => {
     if (event.notification.data?.kirora) return; // Kirora's: handled by kirora-sw.js
     // …your own handling
   });
   ```

   A worker holds one push subscription, so Kirora can't share yours with another push
   provider. If you register a different worker at the same scope later, it replaces
   `kirora-sw.js` and Kirora's pushes stop.

   For generated workers, configure the generator to import the script. `importScripts`
   requires a classic worker; it cannot be used in a module worker. If your worker is
   bundled, `import '@kirora/web/kirora-sw.js'` works too: the package marks it as having
   side effects, so bundlers keep it. The SDK refuses to replace a different worker and
   logs what to change.

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
the user agreed to receive marketing pushes. Transactional pushes need only the browser
permission.

For a "notifications on/off" setting in your app, use `getPushStatus()` and
`setPushEnabled()`. They're about this browser, not the user: the choice is kept on the
device and applies to whoever signs in next, until it's turned on again.

```ts
toggle.checked = (await kirora.getPushStatus()) === 'enabled';
toggle.addEventListener('change', () => kirora.setPushEnabled(toggle.checked));
```

`getPushStatus()` never prompts. It answers the browser's permission first (`denied`,
`unanswered` or `unsupported`); with permission granted, `enabled` when this browser is
registered for the signed-in user, and `disabled` otherwise (turned off, signed out, its
latest registration failed, or the browser dropped its subscription). `setPushEnabled(false)`
detaches the browser (retried in the background as `logout()`'s is) and cancels its
subscription; `setPushEnabled(true)` registers it again if permission is already
granted, without prompting. Answering `requestPushPermission()` with `granted` also turns
push back on. Neither is marketing consent, which `setPushConsent()` records.

Tapping a notification opens its link, or the tapped button's. With no link, it brings
an open tab of your site forward, or opens the service worker's scope (usually your
home page). To route on the push's `data` yourself, listen for taps:

```ts
kirora.addNotificationClickListener((data) => router.push(`/orders/${data.orderId}`));
```

The listener hears each tap once, with the push's `data` (string values), after the tap
was reported. It runs in the page the tap opened, or the tab it brought forward, so only
links on your own site reach it. A tap that arrives before you add a listener is held
(the latest ten) for the first one. A page the tap opened has a minute to load the SDK
and hear it. Remove a listener with
`removeNotificationClickListener()`.

If the user blocks notifications for your site, the SDK tells Kirora the next time
someone signs in on this browser, or when they answer the prompt with a block. Kirora
then stops counting the browser as reachable. Only a browser that was registered before
is reported.

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
rendering is safe. Call SDK methods from the browser; once the client is created there,
sessions and optional page views can be queued before `identify()`.

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
      'setPushEnabled',
      'setTrackingConsent',
      'addNotificationClickListener',
      'removeNotificationClickListener',
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
  kirora.track('Signed Up');
</script>
```

The queued calls are replayed one at a time, each after the one before has finished, so
an event tracked after `identify()` or `logout()` belongs to the user that left signed in.
Calls made while they replay join the end of the queue. Then `window.kirora` becomes the
SDK instance, and calls through a reference to the snippet kept from before go straight to
it. `requestPushPermission()` isn't queued because it must run during a click, and
`getPushStatus()`, `flush()` and `destroy()` aren't because they answer something or act
at once, so call them after the SDK has loaded. A click listener added through the snippet
is added once the SDK loads, and hears a tap that opened the page all the same.

</details>

## Install with an AI coding agent

Paste this into your agent (Claude Code, Cursor, Copilot and so on):

```text
Install the Kirora web SDK in this app: add the @kirora/web package with this project's
package manager, then follow node_modules/@kirora/web/llms.txt step by step. Ask me for
the client key and SDK token secret, and before setting up consent or web push.
```

The packaged [llms.txt](llms.txt) covers the integration steps and checks for common mistakes.

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

`apiUrl` is only for staging or a private deployment. Give the address with its path if it
has one; the SDK adds `/client/v1` after it. Each address, path and all, keeps its own
queue, session, device id and consent on the browser.

### Methods

| Method                                      | Description                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `identify(token?)`                          | Sets the user, starts sending queued events and registers for push if allowed                          |
| `logout()`                                  | Tries to send queued events and detach this browser, within 5 seconds; forgets the user. Never rejects |
| `track(name, properties?)`                  | Tracks an event                                                                                        |
| `trackPageView()`                           | Tracks `Page Viewed` for the current page                                                              |
| `requestPushPermission()`                   | Shows the browser prompt. Returns `granted`, `denied`, `unanswered` or `unsupported`                   |
| `getPushStatus()`                           | `enabled`, `disabled`, `denied`, `unanswered` or `unsupported`. Never prompts                          |
| `setPushEnabled(enabled)`                   | This browser's own push on/off, kept for whoever signs in. Never rejects                               |
| `setPushConsent(granted)`                   | Records consent to marketing pushes                                                                    |
| `addNotificationClickListener(listener)`    | Hears taps on Kirora pushes, with the push's `data`                                                    |
| `removeNotificationClickListener(listener)` | Stops a listener hearing taps                                                                          |
| `setTrackingConsent(granted)`               | Records tracking consent. A refusal is honoured with or without `requireTrackingConsent`               |
| `flush()`                                   | Tries to send queued events now. Some may wait for a retry. Rarely needed                              |
| `destroy()`                                 | Stops timers, listeners and sending, e.g. on hot reload. Queued events stay for the next client        |

### Errors

Every error the SDK throws is a `KiroraError`, so one `instanceof` check catches them all:

- `KiroraApiError` when Kirora refuses a call, with `status`, `code`, `retryAfterMs` and
  `retryable`.
- `UserTokenError` when `fetchUserToken` fails, answers no token (`null` or empty) or
  doesn't answer within 30 seconds. During
  delivery it's logged instead, `onAuthenticationFailed` is called, and queued events are
  retried later.
- `KiroraError` itself for a setup problem (no token and no `fetchUserToken`, an `apiUrl`
  that isn't an address) or a call that couldn't reach Kirora or was cut off, with the
  network's error as `cause`. Anything else that goes wrong is a `KiroraError` too, with
  the original error as `cause`.

`identify()` rejects for setup problems, when `fetchUserToken` fails, and when Kirora
refuses the token while registering this browser for push. A token refused while events
are sent in the background is reported to `onAuthenticationFailed` instead, unless
`identify()` rejects for it: each refusal is reported once.
`setPushConsent()` rejects whenever Kirora hasn't recorded the choice, so you can ask
again later; after `destroy()` it does nothing. `requestPushPermission()` answers the
permission even if this browser then couldn't be registered: that's logged, and
`getPushStatus()` says `disabled`.

`track()` never throws: events Kirora refuses are logged, and so is an event without a
name or whose properties aren't an object, which isn't tracked.

## How it works

- **Batching.** Events are sent in batches: immediately once 20 are queued, otherwise every
  30 seconds, when the tab is hidden and when the browser comes back online.
- **Reliable delivery.** Up to 1,000 events (and 1 MB) are kept in `localStorage`, shared
  between tabs; past that, the oldest are dropped. Failed requests are retried with
  exponential backoff, never sooner than `Retry-After`. Each event has an idempotency key,
  so Kirora can deduplicate retries. An event is only removed once Kirora has answered
  for it; events it rejects outright are logged and dropped so they don't block the queue,
  while those refused for a passing reason (rate limits, server errors) are retried. A
  batch refused as too large (413), or with a 400 or 422 naming an event's field, is
  sent in halves until the event to blame is found, and only that one is dropped. A 400
  or 422 that names no event (a problem with the request itself), and a status
  Kirora doesn't give for a batch (a 403, 404 or 409 from a wrong `apiUrl`, a proxy or a
  captive portal), keep the whole batch for a retry. A
  single event over 1 MB is dropped here; Kirora itself refuses properties over 16 KB. While the tab is hidden, batches go with `keepalive`
  and stay under 60 KB together; an event too large for that waits until the tab is shown
  again. Firefox only honours `keepalive` from version 133: before that, a batch sent as
  the tab closes may be cut off, and goes on the next visit instead. Chrome 80 refuses
  `keepalive` for a request that needs a CORS preflight, as Kirora's do; the SDK then
  sends without it, which works while the tab is only hidden.
- **Users stay apart.** An event tracked while a user is signed in is only ever sent as
  that user, even if another signs in before it's sent. Events tracked before sign-in are
  adopted by whoever signs in next, once, even with several tabs open. Each workspace's
  queue, session, device id and consent answer are kept separately.
- **If storage fails.** If `localStorage` is blocked or full, the SDK keeps events in memory
  instead and logs that once. They're still sent, but lost if the page reloads first. Once
  writes fail, a tracking grant saved earlier no longer counts (it may be out of date), so
  with `requireTrackingConsent` nothing more is tracked until `setTrackingConsent(true)`
  is called again; a saved refusal still holds. A refusal that can't be saved deletes a
  grant saved earlier, so it can't come back on the next page.
- **Event context.** Each event includes a `context` alongside your properties: the page
  (`url`, `path`, `search`, `title`, `referrer`, using the canonical URL if the page has
  one, as Segment does), the page's `utm_*` tags as `campaign` (`source`, `medium`,
  `name`, `term`, `content`), `locale`, `timezone`, `sessionId` and `device.id`. Kirora
  adds the IP address, user agent and `library` on the server. Segments and journeys
  filter on an event's properties, not its context.
- **Privacy.** Page addresses and the referrer are sent with their query strings; only URL
  fragments are dropped. Remove tokens and personal data from your addresses before the
  SDK tracks a page (see [Page views](#page-views)).
- **Push reporting.** To report how push notifications perform, the SDK sends:
  - the browser's language and time zone, when it registers the browser for push or
    reports that notifications are blocked;
  - when a Kirora notification is shown or tapped.

  Push registration details, delivery receipts and notification taps are operational
  push reports, separate from behavioural tracking consent and from marketing push
  consent: `setTrackingConsent(false)` doesn't turn them off. (The web SDK doesn't report
  app opens, the one push report that tracking consent controls on mobile.)

  It never sends hardware or advertising identifiers. Kirora reads the browser and OS
  from the user agent; the SDK sends no app or OS version.

- **Device id.** `device.id` and the session are stored in a first-party cookie on your
  root domain, so `www.` and `app.` subdomains are treated as the same visitor.
- **Clock skew.** Event times are corrected on the server for differences in the device's
  clock.

## What the SDK stores

SDK cookies and `localStorage` entries are first-party. Other scripts running on your
origin can read them. Tracking consent gates event, session and tracking device-ID
storage; its decision is stored independently, as are push registrations when enabled.
Creating the client also briefly writes and removes `kirora:probe` to test storage availability.

| Where                                          | Name                                                                                  | Holds                                                                                                                           | Removed                                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `localStorage`                                 | `kirora:events:<client key>@<api host and path>`                                      | Events waiting to be sent, with their properties and context                                                                    | Once Kirora answers for them; the user's at `logout()`; all on consent withdrawal. Oldest dropped past 1,000 events or 1 MB                                  |
| `localStorage`                                 | `kirora:events:<client key>@<api host and path>:revision`                             | A count of the queue's writes, so a tab can tell its copy is up to date (below)                                                 | Never; a number                                                                                                                                              |
| Cookie on your root domain, and `localStorage` | `kirora_session_…`, `kirora:session:<client key>@<api host and path>`                 | Each live session (up to five, one per user active in this browser): its id, a hash of whose it is, and when it was last active | On consent withdrawal; a user's at their `logout()`. A session ends after 30 minutes without activity                                                        |
| Cookie on your root domain, and `localStorage` | `kirora_installation_id_…`, `kirora:installation-id:<client key>@<api host and path>` | `device.id`: a random id for this browser                                                                                       | On consent withdrawal, unless the browser is registered for push: then at `logout()`                                                                         |
| `localStorage`                                 | `kirora:tracking-consent:<client key>@<api host and path>`                            | The visitor's tracking consent answer                                                                                           | Never; it's their answer. A grant is deleted if a later refusal can't be saved, so it can't come back                                                        |
| `localStorage`                                 | `kirora:tracking-refused:<client key>@<api host and path>`                            | A second copy of a tracking refusal                                                                                             | When the visitor grants tracking consent                                                                                                                     |
| `localStorage`                                 | `kirora:push-registration:<client key>@<api host and path>`                           | Who this browser was registered for, its push endpoint, and when                                                                | At `logout()` and `setPushEnabled(false)`                                                                                                                    |
| `localStorage`                                 | `kirora:push-disabled:<client key>@<api host and path>`                               | That `setPushEnabled(false)` holds on this browser                                                                              | At `setPushEnabled(true)`, or when the prompt is answered `granted`                                                                                          |
| IndexedDB                                      | `kirora-push` database                                                                | The push subscription last registered, the client key and API address, for the service worker                                   | When Kirora refuses a replaced subscription, at `setPushEnabled(false)`, or when a failed detach cancels the subscription; replaced by the next registration |
| IndexedDB                                      | `kirora-locks` database                                                               | The queue's write count (as above), and a lock between tabs in browsers without Web Locks                                       | Never; it holds only numbers                                                                                                                                 |
| The browser's push service                     | (the push subscription)                                                               | Where to deliver pushes                                                                                                         | At `setPushEnabled(false)`, or if `logout()` can't reach Kirora; otherwise kept for the next user                                                            |
| Memory only                                    |                                                                                       | The user token                                                                                                                  | When the page closes, or at `logout()`; a signed-out user's is kept until their browser is detached (at most a day)                                          |

The cookies are `SameSite=Lax`, `Secure` on HTTPS, and last a year; their value is the
same as the `localStorage` copy, which restores a cleared cookie. If `localStorage` is
unavailable or full, the SDK keeps these in memory for the page's life instead.

Several tabs share the queue, and change it one at a time under a Web Lock. Browsers
older than Firefox 96 and Safari 15.4 have no Web Locks, so there the SDK uses an
IndexedDB transaction as the lock instead, in the `kirora-locks` database. A lock alone
isn't enough: a tab's copy of `localStorage` can lag behind another tab's write for a
moment (Chromium delivers it after the lock), and changing a stale copy would lose that
tab's events. So each write is counted, in IndexedDB, which every tab reads alike, and
beside the queue; a tab holding the lock waits until its copy shows the latest write.
Where IndexedDB is refused (some private windows), nothing tells a tab when another
tab's write has arrived. While another tab is writing the queue, the SDK waits a moment
before reading, which in Chromium cut the events two busy tabs lose from about 20% to
about 0.3%; two tabs signing in at the same instant there can also both adopt the same
event from before sign-in.

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
there, its `connect-src` must allow Kirora's API too, which is where deliveries, opens
and clicks are reported, and replaced subscriptions are sent. The worker reports only to
addresses under your `apiUrl` followed by `/t/p/`, as Kirora builds them.

## Naming events

Segments, journeys and goals match event names exactly (case included), so keep them
consistent:

- Use an object followed by a past-tense action, in Title Case: `Plan Upgraded`,
  `Payment Succeeded`, `Signed Up`.
- Name what the user did, not where: `Order Completed` with `{ "source": "checkout" }`,
  not `Checkout Page Button Clicked`.
- Put details in properties: `Plan Upgraded` with `{ "plan": "pro" }`, not
  `Pro Plan Upgraded`.
- Use the standard names where they apply: `Order Completed`, `Signed Up`,
  `Trial Started`, `Subscription Started`, `Subscription Cancelled`, `Payment Failed`,
  `Payment Succeeded`, and for shops `Product Viewed`, `Product Added` and so on.
  Kirora's templates, goals and Kiro look for these; a workspace can map its own names
  under **Settings › Workspace › Key events**.
- Send each property with the same type every time, keys in `snake_case`, and amounts in
  major units (`49.99`, not `4999`).

Kirora enforces:

- Names of 1 to 128 characters, without control characters, trimmed. At most 1,000
  different names per workspace.
- Property keys of at most 64 characters; properties of at most 16 KB as JSON.
- Names starting with `contact.` are reserved, and `Ordered Product` is recorded by
  Kirora from each `Order Completed`'s products, so don't send it.
- `Session Started` and `Page Viewed` are the SDK's own: track them only through the SDK.

## Using your events in Kirora

The SDK's events are stored as events your server sends through Kirora's API are, so
everything that reads events reads them:

- **Segments** match contacts who did an event, how often (at least, exactly or at most;
  "exactly 0" is never), within a time window, with up to five property conditions, and
  optionally not followed by another event.
- **Journeys** can start when an event arrives (with property conditions), wait until an
  event, or end on one. Messages can use the event's properties, as
  `{{ event.properties.plan }}`.
- **Conversion goals** on a campaign or journey count an event as a conversion, and can
  add up one of its properties (`total`, say) as revenue.
- **Workspace goals** measure counts, ratios and conversions between events.
- **Campaigns** go to segments and lists, so an event reaches a campaign through a
  segment.

The contact is the signed-in user, by the `sub` in their token. For example, with
`kirora.track('Trial Started', { plan: 'pro' })` a segment of "did `Trial Started` at
least once in the last 14 days, where `plan` equals `pro`" picks up that user, and a
journey that starts on `Trial Started` can greet them by plan.

## How web differs from Kirora's mobile SDKs

The behaviour Kirora's SDKs share is the same on every platform. What's specific to the
browser:

- **Pages, not screens:** `trackPageView()` and the `trackPageViews` option; no
  `trackScreenView()` or app lifecycle events. Event context has `page` and `campaign`
  where mobile has `app`, `os` and `screen`.
- **No `getState()`** and no `handleDeepLink`: a tap on a push opens its link from the
  service worker, and click listeners get only the push's `data`. Web reports no
  influenced app opens.
- **Push needs a service worker** (`kirora-sw.js`), and the browser's support: on iPhone
  and iPad, iOS 16.4 or later, for a site added to the Home Screen. The registration
  sends no app or OS version; Kirora reads the user agent.
- **Shared across subdomains:** the session and `device.id` are kept in a cookie on your
  root domain.
- **Closing a tab:** events go with `keepalive`, at most 60 KB at once, as the page hides.
- **`beforeSend` sees `context`** on web; the React Native and Flutter wrappers can't
  redact it.

## Verify your integration

1. Request `/kirora-token` signed out: expect `401` and `Cache-Control: no-store`.
   Signed in, expect a plain-text JWT for the session user, with the same cache header.
2. Temporarily set `logLevel: 'debug'`, identify a signed-in user and track an event.
   Look for `Kirora: Sent … events` within 30 seconds or after switching tabs.
   Debug logs say how many events were sent, not what they held; remove this setting
   after checking.
3. If consent is required, check that tracking is blocked before acceptance and that
   withdrawing consent clears the queue.
4. For push, check that your service worker URL serves JavaScript, then enable
   notifications from a click and send a test push from the dashboard.

## Troubleshooting

| Symptom                                     | Check                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Events remain queued                        | Call `identify()` on each signed-in page load; check tracking consent, connectivity and the token route.                                                |
| Token request fails or Kirora returns `401` | Use the authenticated session's user ID, the correct workspace SDK token secret and an unexpired token. Never use the public client key to sign tokens. |
| Events disappear on reload                  | Check browser storage restrictions and queue limits. In-memory fallback cannot persist across reloads.                                                  |
| Notification permission is `unsupported`    | Enable `push`, use a supported browser and secure context, and check iOS home-screen requirements.                                                      |
| Push registration fails                     | Check the dashboard push app, the worker URL and existing worker registrations.                                                                         |
| CSP blocks requests or scripts              | Check [Content Security Policy](#content-security-policy), including headers served with the worker.                                                    |

## Support and contributing

For integration help, email [support@kirora.io](mailto:support@kirora.io).
See [CONTRIBUTING.md](CONTRIBUTING.md) for bug reports and local development,
and [SECURITY.md](SECURITY.md) to report vulnerabilities privately.

## License

[MIT](LICENSE)
