# Reference

How `@kirora/web` delivers events, what it stores in the browser, the Content Security
Policy it needs, and how it differs from Kirora's mobile SDKs.

## Delivery

- **Batching.** Events go in batches: at once when 20 are queued, otherwise every 30
  seconds, when the tab is hidden, and when the browser comes back online.
- **Queue.** Up to 1,000 events (and 1 MB) wait in `localStorage`, shared between tabs;
  past that, the oldest are dropped. An event is removed only once Kirora has answered for
  it.
- **Retries.** Failed requests are retried with exponential backoff, never sooner than
  `Retry-After`. Each event has an idempotency key, so Kirora drops duplicates. Events
  Kirora rejects outright are logged and dropped, so they don't block the queue; those
  refused for a passing reason (rate limits, server errors) are retried.
- **One bad event.** A batch refused as too large (413), or with a 400 or 422 naming one of
  its events, is sent in halves until the event to blame is found, and only that one is
  dropped. A refusal that names no event (a problem with the request itself), and a status
  Kirora doesn't give for batches (a 403, 404 or 409 from a wrong `apiUrl`, a proxy or a
  captive portal), keep the batch for a retry. A single event over 1 MB is dropped here;
  Kirora refuses properties over 16 KB.
- **Closing the tab.** While the tab is hidden, batches go with `keepalive`, under 60 KB
  together; a larger event waits until the tab is shown again. Firefox honours
  `keepalive` from version 133: before that, a batch sent as the tab closes may be cut off,
  and goes on the next visit instead. Chrome 80 refuses `keepalive` for Kirora's requests,
  so the SDK sends without it there, which works while the tab is only hidden.
- **Users stay apart.** An event tracked while a user is signed in only ever goes as that
  user, even if someone else signs in before it's sent. Events from before sign-in are
  adopted by whoever signs in next, once, even with several tabs open (see
  [limits](#if-storage-fails) where IndexedDB is refused).
- **Workspaces stay apart.** Each client key and `apiUrl` (path included) keeps its own
  queue, session, device ID and consent answer.

### Event context

Each event carries a `context` beside your properties:

- the page: `url`, `path`, `search`, `title`, `referrer`, using the canonical URL if the
  page has one;
- the page's `utm_*` tags, as `campaign` (`source`, `medium`, `name`, `term`, `content`);
- `locale`, `timezone`, `sessionId` and `device.id`.

Kirora adds the IP address, user agent and library on its server, and corrects event
times for a device clock that's off. The SDK sends no hardware or advertising
identifiers.

## What the SDK stores

Everything is first-party, so other scripts on your origin can read it. Tracking consent
gates the events, the session and the device ID; the consent answer itself and push
registrations are stored regardless. `<ns>` below is `<client key>@<api host and path>`.

| Where                          | Name                                                           | Holds                                                                                            | Removed                                                                                  |
| ------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `localStorage`                 | `kirora:events:<ns>`, and `…:revision`                         | Events waiting to be sent; a count of the queue's writes                                         | Once Kirora answers for them; the user's at `logout()`; all on consent withdrawal        |
| Root-domain cookie and storage | `kirora_session_…`, `kirora:session:<ns>`                      | Up to three live sessions, one per user active here: id, a hash of whose, last active            | A user's at their `logout()`; all on consent withdrawal; a session ends after 30 minutes |
| Root-domain cookie and storage | `kirora_installation_id_…`, `kirora:installation-id:<ns>`      | `device.id`: a random ID for this browser                                                        | On consent withdrawal, unless registered for push: then at `logout()`                    |
| `localStorage`                 | `kirora:tracking-consent:<ns>`, `kirora:tracking-refused:<ns>` | The tracking consent answer, and a second copy of a refusal                                      | The answer is kept; the second copy goes when consent is granted                         |
| `localStorage`                 | `kirora:push-registration:<ns>`                                | Who this browser was registered for, its push endpoint, and when                                 | At `logout()` and `setPushEnabled(false)`                                                |
| `localStorage`                 | `kirora:device-secret:<ns>`                                    | A random secret sent with push registrations, to detach with nobody signed in. Never in a cookie | With the device ID                                                                       |
| `localStorage`                 | `kirora:push-pending-detach:<ns>`                              | A detachment still being retried                                                                 | Once Kirora answers it, or after a day                                                   |
| `localStorage`                 | `kirora:push-disabled:<ns>`                                    | That `setPushEnabled(false)` holds on this browser                                               | At `setPushEnabled(true)`, or when the prompt is answered `granted`                      |
| IndexedDB                      | `kirora-push`                                                  | The subscription last registered, client key and API address, for the service worker             | When the subscription is cancelled or refused; replaced by the next registration         |
| IndexedDB                      | `kirora-locks`                                                 | Counters and locks that keep tabs' queue writes in order                                         | Never; it holds only numbers                                                             |
| Memory only                    |                                                                | The user token                                                                                   | When the page closes or at `logout()`; never stored                                      |

Creating the client briefly writes and removes `kirora:probe` to test storage. The cookies
are `SameSite=Lax`, `Secure` on HTTPS, and last a year, so `www.` and `app.` subdomains
share a visitor; the `localStorage` copy restores a cleared cookie.

### If storage fails

- If `localStorage` is blocked or full, the queue and consent answer are kept in memory for
  the page's life, and that's logged once. Events are still sent, but lost if the page
  reloads first. The session and device ID still use the cookie if cookies work.
- Once writes fail, a tracking grant saved earlier no longer counts (it may be out of
  date), so with `requireTrackingConsent` nothing more is tracked until
  `setTrackingConsent(true)` is called again; a saved refusal still holds.
- Where IndexedDB is refused (some private windows), tabs can't fully coordinate their
  queue writes: two busy tabs can lose a small share of events (about 0.3% in testing),
  and two tabs signing in at the same moment can both adopt the same event from before
  sign-in.

## Content Security Policy

If your site sets a CSP, allow:

| Directive     | Allow                                                                                 |
| ------------- | ------------------------------------------------------------------------------------- |
| `connect-src` | `https://api.kirora.io`, or your `apiUrl`                                             |
| `script-src`  | `https://cdn.jsdelivr.net` if you load the SDK from the CDN; nothing if you bundle it |
| `worker-src`  | `'self'`, for `kirora-sw.js` (service workers are always same-origin)                 |

The [script-tag](script-tag.md) snippet is inline, so it needs a `nonce` or a `sha256-`
hash in `script-src`, never `'unsafe-inline'`; or put it in a file on your own origin.

A service worker gets its own CSP from the headers it's served with. If you set one
there, its `connect-src` must allow Kirora's API too: the worker reports deliveries and
taps, and sends replaced subscriptions, to addresses under your `apiUrl` followed by
`/t/p/`.

## How web differs from Kirora's mobile SDKs

The behaviour Kirora's SDKs share is the same everywhere. Specific to the browser:

- **Pages, not screens:** `trackPageView()` and `trackPageViews`; no `trackScreenView()` or
  app lifecycle events. Event context has `page` and `campaign` where mobile has `app`,
  `os` and `screen`.
- **No `getState()` or `handleDeepLink`:** a tap opens its link from the service worker,
  and click listeners get only the push's `data`. Web reports no influenced app opens.
- **Push needs a service worker** (`kirora-sw.js`) and browser support; on iPhone and iPad,
  iOS 16.4 or later, for a site on the Home Screen.
- **Shared across subdomains:** the session and device ID live in a root-domain cookie.
- **Closing a tab:** events go with `keepalive`, at most 60 KB at once.
- **`beforeSend` sees `context`** on web; the React Native and Flutter wrappers can't
  redact it.
