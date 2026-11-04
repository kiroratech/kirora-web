# Examples

Two small apps showing a complete integration: sign-in, the token route, `identify()`,
page views, `track()`, `logout()` and web push. Both use the SDK built from this repo.

| Example                    | Shows                                                    |
| -------------------------- | -------------------------------------------------------- |
| [`nextjs`](nextjs)         | Next.js App Router: client singleton, server token route |
| [`script-tag`](script-tag) | Plain HTML with the loader snippet, and a Node server    |

Sign-in in both is a stand-in: whoever you type is signed in. Your app uses its own auth;
the token route must take the user from your session, never from the request.

## Before you start

You need a client key and token secret from **Developer → SDK** in the Kirora dashboard,
and for push, a web push app. Build the SDK first:

```sh
pnpm install
pnpm build
```

## Next.js

```sh
cp examples/nextjs/.env.example examples/nextjs/.env.local   # then fill it in
pnpm --filter kirora-web-example-nextjs dev
```

Open http://localhost:3000. To copy it into your own app, install `@kirora/web` from npm
and drop the `turbopack` and `outputFileTracingRoot` settings in `next.config.ts`.

## Script tag

No dependencies:

```sh
KIRORA_CLIENT_KEY=kirora_pk_… KIRORA_SDK_TOKEN_SECRET=… node examples/script-tag/server.mjs
```

Open http://localhost:3000. Set `KIRORA_API_URL` for staging or a private deployment. On
your own site, load the SDK from the CDN with an exact version and serve `kirora-sw.js`
from your site's root.

## Checking it works

Both set `logLevel: 'debug'`, so the console shows each batch sent. Sign in, click a track
button, and look for `Kirora: Sent … events`; switching tabs sends right away.
