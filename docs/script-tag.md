# Script tag

Use `@kirora/web` without a bundler. You still need the [token route](../README.md#2-add-a-token-route-to-your-server)
on your server.

Add this snippet to your `<head>`. It queues calls until the SDK loads, then replays them
in order. Set your client key, and pin the CDN URL to the SDK version you use.

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

## How queued calls run

- They're replayed one at a time, each after the one before has finished, so an event
  tracked after `identify()` or `logout()` goes as whoever that left signed in. Calls made
  while they replay join the end of the queue.
- Then `window.kirora` becomes the SDK itself, and calls through a reference to the snippet
  go straight to it.
- A click listener added through the snippet is added once the SDK loads, and still hears
  a tap that opened the page.

## Calls that need the SDK loaded

`requestPushPermission()` isn't queued, because it must run during a click, and
`getPushStatus()`, `flush()` and `destroy()` aren't, because they answer something or act
at once. They exist once the SDK has loaded. Queued calls don't return promises either, so
to await `logout()`, wait until the queued calls have run: `window.kirora` is then the SDK,
no longer an array.

```js
function kiroraReady() {
  return new Promise(function (resolve) {
    (function check() {
      if (!Array.isArray(window.kirora)) return resolve(window.kirora);
      setTimeout(check, 50);
    })();
  });
}

button.addEventListener('click', function () {
  // The prompt must open during the click, so there's no waiting here.
  if (typeof window.kirora.requestPushPermission === 'function') {
    window.kirora.requestPushPermission();
  }
});

signOutLink.addEventListener('click', async function (event) {
  event.preventDefault();
  await (await kiroraReady()).logout();
  location.href = '/sign-out';
});
```

## Content Security Policy

The snippet is inline, so it needs a `nonce` or a `sha256-` hash in `script-src` (never
`'unsafe-inline'`), or put it in a file on your own origin. Allow
`https://cdn.jsdelivr.net` in `script-src` too. See the full
[CSP settings](reference.md#content-security-policy).
