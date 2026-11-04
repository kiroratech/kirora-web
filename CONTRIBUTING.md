# Contributing

Thanks for helping improve `@kirora/web`.

## Questions and support

For help with your integration, email **support@kirora.io**. Issues are for bugs and
feature requests only.

## Security issues

Don't open a public issue. See [SECURITY.md](SECURITY.md).

## Reporting bugs

[Open an issue](../../issues/new/choose) using the bug report form. A minimal code
sample that reproduces the problem is the most useful thing you can include.

## Requesting features

Open an issue using the feature request form. Describe the problem you're trying to
solve, not just the solution. We read every request, but can't promise to build them
all.

## Pull requests

Small fixes (bugs, docs, typos) are welcome as pull requests directly. For new features
or changes to the public API, please open an issue first so we can agree on the approach.
Kirora's SDKs share the same API across platforms, so these changes need to be designed
together.

Before submitting:

- Add or update tests for your change.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm format:check`.
- Update the README if you changed public behaviour.
- Once the SDK is on npm, run `pnpm changeset` to describe any change users will
  notice. It goes in the changelog and decides the next version.

## Development

```sh
pnpm install
pnpm build           # writes dist/
pnpm test            # or pnpm test:watch
pnpm lint
pnpm typecheck
pnpm size            # bundle sizes against their budgets in .size-limit.json
pnpm check:package   # publint and Are the Types Wrong against the packed tarball
pnpm check:consumers # installs the packed tarball with npm, Yarn and pnpm, and uses it
```

`pnpm build` writes `dist/index.js` (ES module), `dist/kirora.min.js` (script tag build),
`dist/kirora-sw.js` and the type declarations, with source maps.

`test/api.test.ts` runs against a real Kirora API when `KIRORA_API_URL`,
`KIRORA_CLIENT_KEY` and `KIRORA_TOKEN_SECRET` are set, and is skipped otherwise.

### Layout

```
src/
  index.ts         npm entry: the public API, and nothing else
  types.ts         the public types: options, answers, event properties
  errors.ts        KiroraError and its subclasses
  kirora.ts        the Kirora class: a facade wiring the parts below together
  cdn.ts           script-tag entry: the same exports, and replays the loader's calls
  version.ts       SDK_VERSION, injected at build time
  identity/        who is signed in: tokens, refresh, and the rules for changing user
  api/             the /client/v1 transport: headers, timeouts, errors
  events/          the offline queue and batched delivery
  tracking/        events, sessions, page context and lifecycle, consent, installation id
  push/            web push registration
    worker/        the service worker, built to dist/kirora-sw.js (own tsconfig)
  storage/         localStorage with its memory fallback, cookies, and every key name
  utils/           logging, UUIDs, base64url, timeouts
test/              Vitest tests, mostly through the public API; fakes in fake-kirora.ts
examples/          Next.js and script-tag apps, see examples/README.md
scripts/           check-package.sh and check-consumers.sh (npm, Yarn and pnpm, in parallel)
llms.txt           the install guide for AI agents, shipped in the package
```

Dependencies point one way: `kirora.ts` uses everything; `tracking/`, `events/` and
`push/` use `api/`, `identity/`, `storage/` and `utils/`, and `tracking/` feeds `events/`; `api/` uses `identity/`; those
use nothing but `errors.ts`, `types.ts` and `utils/`. Add a public type to `types.ts` and export it from `index.ts`; anything not
exported there is internal.

### Conventions

- **Files** are kebab-case and named for what they hold (`event-queue.ts`). **Classes and
  types** are PascalCase nouns; **functions and methods** camelCase, starting with a verb
  (`fitBatch`, `classifyFailure`). **Constants** are SCREAMING_SNAKE with their unit
  (`FLUSH_INTERVAL_MS`, `MAX_BATCH_BYTES`).
- **Booleans** read as states or questions (`signedIn`, `allowed`, `isPageHidden()`).
  **Callbacks** start with `on` (`onEventQueued`). No boolean parameters that switch
  behaviour: write two methods (`flush()` and `flushWhenDue()`).
- **One job per module and class.** `Kirora` only wires the parts together and owns
  the public methods; each part takes the collaborators it needs (only the members it
  uses, as `Tracker` does with `Pick<…>`), so it can be tested alone.
- **Names match the shared interface and the wire:** `installation id`, `push app`,
  `user token`, `tracking consent` and `push consent` each mean one thing.
- **Comments say why**, not what. Public API gets TSDoc, since it shows in editors.
- Errors thrown by the SDK are `KiroraError`s; the console is only reached through the
  logger.

The behaviour every Kirora client SDK shares (options, methods, delivery, sessions,
consent, the `/client/v1` wire contract) is defined in Kirora's client SDK interface.
Change it there first.

### Releases

Merging to `main` opens or updates a "Version packages" pull request from the pending
changesets. Merging that pull request publishes to npm with provenance.

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
