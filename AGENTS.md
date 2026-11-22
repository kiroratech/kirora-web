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

Update the README, the guides in `docs/` and `llms.txt` if public behaviour or setup
changed, and add changes users will notice to `CHANGELOG.md` under `Unreleased`. Never
bump the version or publish unless asked: merging a version bump to `main` publishes it.
