# Working on @kirora/web

Instructions for AI coding agents changing this repository. To install the SDK in an app,
see [llms.txt](llms.txt) instead.

## Ground rules

- The behaviour every Kirora client SDK shares (options, methods, delivery, sessions,
  consent, the `/client/v1` wire contract) is defined in Kirora's client SDK interface,
  `docs/sdk-interface.md` in the omnichannel repo. Change it there first; don't add public
  options or methods here on your own.
- Zero runtime dependencies. Don't add one.
- A failing Kirora must never break the host page: no throwing from `track()`, the
  constructor, or anything on a timer.
- An event tracked while a user is signed in is only ever sent with that user's token.
- Supported browsers: Chrome 80, Firefox 74, Safari 14. Check APIs against them.

## Layout and commands

See [CONTRIBUTING.md](CONTRIBUTING.md). Use pnpm (the version in `package.json`).
Before finishing, run:

    pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm size

Update the README and `llms.txt` if public behaviour or setup changed. Once the SDK is on
npm, also add a changeset (`pnpm changeset`) for any change users will notice.
