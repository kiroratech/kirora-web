# Authentication

How `@kirora/web` knows who's signed in: the token route, `identify()`, `logout()`, token
refresh and errors. Start with the [Quickstart](../README.md#quickstart).

## Express token route

This assumes your app provides `app`, `requireSignedIn` (which must answer `401` for
anyone not signed in) and `req.user.id`:

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

Without `@kirora/node`, any JWT library works: HS256, signed with the SDK token secret, with
`sub` (your user ID, as a string), `iat` (now, in Unix seconds) and `exp` (at most 24 hours
later). Kirora refuses a token whose `iat` is more than a minute ahead of its own clock,
and creates the contact the first time it sees a new `sub`.

## identify()

Call it on every page load where the user is signed in, including when your app restores
its own session, and right after they sign in. Tokens stay in memory, so a reload needs
it again.

`identify()` uses `fetchUserToken`, or a token you already have: `identify(token)`. The
argument is a signed token, never a user ID.

It rejects when there's no token and no `fetchUserToken`, when `fetchUserToken` fails,
and when Kirora refuses the token while registering this browser for push. **If it
rejects, nobody is signed in:** events stay queued, but nothing retries the sign-in. Call
`identify()` again, e.g. on the next page load or when your session changes.

Events tracked before sign-in go as the user who signs in next.

## logout()

Call it when the user signs out, before your own sign-out, while the token route can still
authenticate them. Don't call it on every page where nobody is signed in.

`logout()` never rejects and is done within 5 seconds, whatever the network does. In that
time it tries, side by side, to send the user's queued events and to detach this browser
from their pushes. Then it forgets the user, anything of theirs still unsent, and the
events waiting from before they signed in, so the next user never gets them. Events
tracked while it runs go as whoever signs in next.

**With nobody signed in** (a reload where your app restored its session but `identify()`
hasn't run yet), `logout()` still detaches this browser from push, using a secret the
browser made and sent with its registration. It leaves the registration alone while its
user is signed in in another tab. Browsers without Web Locks (before Firefox 96 and Safari
15.4) can't tell, so there it detaches anyway: a tab still signed in gets push back at its
next `identify()`. It drops only the waiting events tracked during a signed-in user's
visit; a visitor who never signed in keeps theirs, for when they sign up.

**If Kirora can't be reached**, the SDK cancels the browser's push subscription at once,
which stops pushes, and keeps retrying the detachment in the background for up to a day,
including on later page loads. A late retry never undoes a newer sign-in.

## Token refresh

With `fetchUserToken`, the SDK asks for a fresh token:

- a minute before the current one's `exp`;
- when the tab is shown again after that time;
- when Kirora refuses the token.

A failed early refresh is tried again every 15 seconds until the token expires. Requests
wait for a refresh under way, so none goes with the token it replaces. A token that
arrives with under a minute left is replaced at once. If the device's clock is ahead, so a
token looks expired as it arrives, its lifetime (`exp` minus `iat`) is counted from its
arrival.

A token passed to `identify(token)` can't be refreshed. Once Kirora refuses it, the SDK
stops sending (keeping the events) until `identify()` is called again, and calls made as
that user, such as `setPushConsent()`, reject at once with a 401 `KiroraApiError`.

## When the token fails

Pass `onAuthenticationFailed` to hear when the user's token fails in the background, where
no method call would tell you:

```ts
const kirora = new Kirora({
  clientKey: 'kirora_pk_…',
  fetchUserToken,
  onAuthenticationFailed: (reason) => showSignInAgain(reason),
});
```

The reason is `fetch_failed` (`fetchUserToken` threw, answered no token, or timed out) or
`refused` (Kirora refused the token and no fresh one was accepted). It's called once per
failure, until a request with the user's token succeeds or `identify()` is called. A
failed early refresh is reported only if refreshing still fails once the token has expired
or been refused.

It's called only while that user is still signed in: never after `destroy()`, after
another user has signed in, or during `logout()`. An error a method already rejected with
isn't reported again here.

## Errors

The SDK's errors are `KiroraError`s, so one `instanceof` check catches them:

- `KiroraApiError` when Kirora refuses a call, with `status`, `code`, `retryAfterMs` and
  `retryable`.
- `UserTokenError` when `fetchUserToken` throws, answers no token (`null`, `undefined` or
  empty), or doesn't answer within 30 seconds. During background delivery it's logged
  instead, and `onAuthenticationFailed` is called.
- `KiroraError` itself for a setup problem (no token and no `fetchUserToken`, an `apiUrl`
  that isn't an address), a call that couldn't reach Kirora or was cut off, or anything
  else, with the original error as `cause`.

Which methods reject:

- `identify()`: see [above](#identify).
- `setPushConsent()` rejects whenever Kirora hasn't recorded the choice, so you can ask
  again later. After `destroy()` it does nothing.
- `requestPushPermission()` answers the permission even if the browser then couldn't be
  registered (that's logged, and `getPushStatus()` says `disabled`). It can reject with the
  browser's own error from its prompt.
- `logout()` and `setPushEnabled()` never reject. `track()` never throws: an event without
  a name, or whose properties aren't an object, is logged and not tracked.
