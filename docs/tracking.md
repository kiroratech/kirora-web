# Tracking

Events, redaction, page views, sessions and consent in `@kirora/web`, and how Kirora uses
the events. Start with the [Quickstart](../README.md#quickstart).

## Events

```ts
kirora.track('Plan Upgraded', { plan: 'pro', seats: 5 });
```

- `track()` returns at once, so there's no need to `await` it, and it never throws.
- Properties are copied as they are when `track()` is called, and must be JSON. An event
  holding something JSON can't (a function, `NaN`, a `Map`, a circular reference) is
  dropped and logged. Dates are sent as ISO strings; `undefined` members are left out.
- Nothing is sent for a visitor who never signs in: Kirora has no anonymous contacts.
  Events tracked before sign-in are queued and go as the next user to sign in. Events
  tracked while a user is signed in only ever go as that user.
- Don't send secrets or sensitive personal data in properties; use
  [`beforeSend`](#redacting-events) to remove what you can't avoid.

Every event counts against your plan's monthly event allowance (1,000 on Free), including
the automatic `Session Started` and `Page Viewed`; past it, Kirora refuses events with
`PLAN_LIMIT_REACHED`. An event that reaches Kirora more than 72 hours after it happened
(one queued while offline, say) starts no journey, though it still counts for segments and
for journeys already under way. One older than your plan keeps events (30 days on Free) is
refused.

## Naming events

Segments, journeys and goals match event names exactly (case included), so keep them
consistent:

- An object, then a past-tense action, in Title Case: `Plan Upgraded`, `Signed Up`.
- Name what the user did, not where: `Order Completed` with `{ "source": "checkout" }`,
  not `Checkout Page Button Clicked`.
- Put details in properties: `Plan Upgraded` with `{ "plan": "pro" }`, not
  `Pro Plan Upgraded`.
- Use the standard names where they apply: `Order Completed`, `Signed Up`,
  `Trial Started`, `Subscription Started`, `Subscription Cancelled`, `Payment Failed`,
  `Payment Succeeded`, and for shops `Product Viewed`, `Product Added` and so on. Kirora's
  templates and goals look for these; a workspace can map its own names under
  **Settings › Workspace › Key events**.
- Send each property with the same type every time, keys in `snake_case`, and amounts in
  major units (`49.99`, not `4999`).

Kirora enforces:

- Names of 1 to 128 characters, without control characters, trimmed; at most 1,000
  different names per workspace.
- Property keys of at most 64 characters; properties of at most 16 KB as JSON.
- Names starting with `contact.` are reserved. `Ordered Product` is recorded by Kirora
  from each `Order Completed`'s products, so don't send it.
- `Session Started` and `Page Viewed` are the SDK's own: track them only through the SDK.

## Redacting events

`beforeSend` is called for every event, including `Session Started` and automatic page
views, before it's stored or sent. It gets a copy of `{ name, properties, context }` and
returns it with fields changed or removed, or `null` to drop the event.

- It must answer at once: an error, a promise, or values JSON can't hold drop the event.
  Only the kind of failure is logged, never the event.
- The event's name, time and idempotency key stay the SDK's. Calling `track()` from inside
  it is refused.
- Change or remove what's in `context`, but don't add fields: Kirora refuses an event
  whose context has fields it doesn't define.

A page address appears in several places, so redact every copy:

```ts
const kirora = new Kirora({
  clientKey: 'kirora_pk_…',
  beforeSend: (event) => {
    const clean = (value: unknown) =>
      typeof value === 'string' ? value.replace(/([?&]token=)[^&#]*/g, '$1') : value;
    const page = event.context.page as Record<string, unknown> | undefined;
    if (page) {
      for (const key of ['url', 'search', 'referrer']) page[key] = clean(page[key]);
    }
    for (const key of Object.keys(event.properties)) {
      event.properties[key] = clean(event.properties[key]);
    }
    return event;
  },
});
```

That covers `context.page` (`url`, `search`, `referrer`), `Page Viewed`'s copy of the page
in its properties, and `Session Started`'s landing `path` and `referrer`.

## Page views

`trackPageViews: true` tracks `Page Viewed` on every page, including single-page app
navigations; a change to the query string alone isn't a new page. Or call
`kirora.trackPageView()` yourself, e.g. from your router.

A page is recorded with its full address, query string included (`url`, `path`, `search`,
`title`, `referrer`), using the canonical URL if the page has one; only the fragment
(`#…`) is dropped. Nothing is masked, so if an address carries a token or personal data (a
password reset or magic link, an `?email=`), redact it with
[`beforeSend`](#redacting-events), or remove it from the address before the SDK tracks
the page:

```ts
const url = new URL(location.href);
url.searchParams.delete('token');
history.replaceState(history.state, '', url);
```

Removing it from the address also keeps it out of the next page's `referrer`. With the
[script tag](script-tag.md), the snippet records the address as it runs, so do this in a
script placed before it.

## Sessions

A session starts with a `Session Started` event, whose properties record how the visitor
arrived (`path`, `referrer` and any `utm_*` tags), for segments and journeys to filter on.
Every event carries the session as `context.sessionId`.

- A session ends after 30 minutes with no events and no visible tab (an open, visible tab
  keeps it going), and at `logout()`.
- Each signed-in user has their own session, shared across tabs and subdomains. A visit
  begun before sign-in becomes the session of whoever signs in.
- After a reload, the visit carries on until `identify()` runs. If someone else signs in
  then, the earlier events go to them without the earlier user's session, so two people's
  visits are never joined.

Set `trackSessions: false` to turn sessions off.

## Tracking consent

With `requireTrackingConsent: true`, nothing is tracked before consent: no events,
sessions or device ID. Events from before consent are discarded, not replayed, and
consenting doesn't track a page view for the page already open. Events already on the
device (say, from before you turned the option on) wait until the visitor consents, and
are deleted if they refuse.

```ts
cookieBanner.onAccept(() => kirora.setTrackingConsent(true));
cookieBanner.onReject(() => kirora.setTrackingConsent(false));
```

The answer is saved on the device, per workspace. Withdrawing consent stops tracking,
cancels a send under way, clears queued events and empties the session cookie on every
subdomain. The device ID is emptied too, unless this browser is registered for push: then
it's kept until `logout()` detaches the browser.

Without `requireTrackingConsent`, tracking is on by default, and `setTrackingConsent(false)`
still turns it off on this device until `setTrackingConsent(true)`.

When the answer can't be trusted, the SDK errs towards not tracking:

- If a saved answer can't be read and no refusal is on record, the visitor is treated as
  new: tracked without `requireTrackingConsent`, not tracked with it.
- If `localStorage` is blocked (some privacy modes), the SDK can't tell whether the visitor
  refused before, so it tracks nothing until `setTrackingConsent(true)` is called on this
  page, with or without the option.

Consent covers tracking, not push registration or other API calls. Push has its own
permission and marketing consent ([push guide](push.md)).

## Using your events in Kirora

The SDK's events are stored like events sent through Kirora's server API, so everything
that reads events reads them. Segments and journeys filter on an event's properties, not
its context.

- **Segments** match contacts who did an event, how often, within a time window, with up
  to five property conditions, and optionally not followed by another event.
- **Journeys** can start when an event arrives, wait for one, or end on one. Messages can
  use its properties, as `{{ event.properties.plan }}`.
- **Conversion goals** on a campaign or journey count an event as a conversion, and can add
  up one of its properties (`total`, say) as revenue.
- **Workspace goals** measure counts, ratios and conversions between events.
- **Campaigns** go to segments and lists, so an event reaches a campaign through a segment.

For example, after `kirora.track('Trial Started', { plan: 'pro' })`, a segment of "did
`Trial Started` in the last 14 days, where `plan` is `pro`" includes that user, and a
journey that starts on `Trial Started` can greet them by plan.
