# Web push

Push in `@kirora/web` beyond the [basic setup](../README.md#web-push): your own service
worker, on/off settings, taps, and what's reported.

## The service worker

`kirora-sw.js` must be served from your own origin, usually the site's root. Copy it in
your build, so it's updated with the SDK:

```sh
cp node_modules/@kirora/web/dist/kirora-sw.js public/kirora-sw.js
# Yarn Plug'n'Play, which has no node_modules:
cp "$(node -p "require.resolve('@kirora/web/kirora-sw.js')")" public/kirora-sw.js
```

The worker shows Kirora's pushes and reports when they're shown and tapped. When the
browser replaces a push subscription, which it can do at any time, the worker tries to
tell Kirora, so the browser can keep receiving pushes without a visit.

## Your own service worker

A scope can have only one service worker. If your site already has one (e.g. a PWA), don't
add a second: serve `kirora-sw.js` next to yours, import it, and point the SDK at yours.

```js
// In your existing /sw.js (a classic worker, not a module worker):
importScripts('/kirora-sw.js');
```

```ts
new Kirora({
  clientKey: 'kirora_pk_…',
  fetchUserToken,
  push: { serviceWorkerUrl: '/sw.js' },
});
```

If your worker is bundled, `import '@kirora/web/kirora-sw.js'` works too: the package marks
it as having side effects, so bundlers keep it. For generated workers, configure the
generator to import the script.

Kirora's listeners then run beside yours. If your own `push` or `notificationclick`
handlers act on every event, have them skip Kirora's, or a push shows twice and a tap opens
two windows:

```js
const isKiroras = (event) => {
  try {
    return event.data?.json().kirora === 'true';
  } catch {
    return false; // not JSON, so not Kirora's
  }
};
self.addEventListener('push', (event) => {
  if (isKiroras(event)) return; // shown by kirora-sw.js
  // …your own handling
});
self.addEventListener('notificationclick', (event) => {
  if (event.notification.data?.kirora) return; // handled by kirora-sw.js
  // …your own handling
});
```

A worker holds one push subscription, so Kirora can't share it with another push
provider. Registering a different worker at the same scope later replaces Kirora's, and
its pushes stop. The SDK itself never replaces a different worker: it logs what to change.

## Permission and consent

Three separate settings:

- **Tracking consent** (`setTrackingConsent`) doesn't affect push.
- **Browser permission** (`requestPushPermission`) is enough for transactional pushes. Ask
  from a click; browsers block the prompt otherwise.
- **Marketing consent** (`setPushConsent`) records whether the user agreed to marketing
  pushes. Record it only from a choice that asked for exactly that.

## An on/off setting

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
latest registration failed, or the browser dropped its subscription).

`setPushEnabled(false)` detaches the browser (retried in the background, as `logout()`'s
is) and cancels its subscription. `setPushEnabled(true)`, or answering
`requestPushPermission()` with `granted`, registers it again, without prompting. Neither is
marketing consent.

## Taps

Tapping a notification opens its link, or the tapped button's. With no link, it brings an
open tab of your site forward, or opens the service worker's scope (usually your home
page). To route on the push's `data` yourself:

```ts
kirora.addNotificationClickListener((data) => router.push(`/orders/${data.orderId}`));
```

- The listener hears each tap once, with the push's `data` (string values).
- It runs in the page the tap opened or brought forward, so only links on your own site
  reach it.
- It's called once the tap is reported, or after 1.5 seconds, whichever comes first, so it
  doesn't prove the report arrived.
- A tap that arrives before you add a listener is held for the first one (the latest ten).
  A page the tap opened has a minute to load the SDK and hear it.

Remove a listener with `removeNotificationClickListener()`.

## Blocked notifications

If the user blocks notifications for your site, the SDK tells Kirora when they answer the
prompt with a block, or the next time someone signs in on this browser. Kirora then stops
counting the browser as reachable. Only a browser that was registered before is reported.

## What's reported

To report how pushes perform, the SDK sends the browser's language and time zone when it
registers the browser or reports a block, and the worker reports when a Kirora
notification is shown or tapped. These are operational reports, separate from tracking
consent and marketing consent: `setTrackingConsent(false)` doesn't turn them off. No
hardware or advertising identifiers are sent; Kirora reads the browser and OS from the
user agent.

## iPhone and iPad

Web push needs iOS 16.4 or later, and works only once the site has been added to the Home
Screen. Otherwise `requestPushPermission()` returns `unsupported`.
