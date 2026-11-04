#!/usr/bin/env bash
# Installs the packed SDK into fresh npm, Yarn and pnpm projects, all at once, and checks
# that each can import it in Node (as server rendering does), type-check against it,
# bundle it and find the service worker. Checks the tarball in $KIRORA_TARBALL if set
# (CI packs once for every check), otherwise packs one.
# Usage: scripts/check-consumers.sh [npm|yarn1|yarn|pnpm ...]
set -euo pipefail
# Run as a customer would: without the settings `pnpm run` passes down as npm_config_*,
# which npm and Yarn would pick up too.
for variable in $(env | grep -o '^npm_config_[^=]*' || true); do unset "$variable"; done
export npm_config_loglevel=error npm_config_update_notifier=false

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if (($#)); then managers=("$@"); else managers=(npm yarn1 yarn pnpm); fi
# What each consumer installs besides the SDK, to type-check and bundle against it.
tools=(typescript@~5.8.3 esbuild)
# Yarn 4 with Plug'n'Play, the strictest resolver: no node_modules at all.
yarn4=(npx -y @yarnpkg/cli-dist@4.18.1)
export YARN_ENABLE_TELEMETRY=0

# Runs a consumer's installed tool: through Yarn 4 for Plug'n'Play, from node_modules
# otherwise.
run() {
  if [[ $manager == yarn ]]; then "${yarn4[@]}" "$@"; else npx --no-install "$@"; fi
}
node_run() {
  if [[ $manager == yarn ]]; then "${yarn4[@]}" node "$@"; else node "$@"; fi
}

tarball=${KIRORA_TARBALL:-}
if [[ -z $tarball ]]; then
  pnpm --dir "$root" pack --pack-destination "$work" >/dev/null
  tarball=$(ls "$work"/*.tgz)
fi

# One consumer, in its own directory. Prints a line of results; fails if any check does.
check() {
  local manager=$1 app="$work/$1"
  mkdir -p "$app"
  cd "$app"
  cat >package.json <<JSON
{ "name": "consumer-$manager", "private": true, "type": "module" }
JSON
  cat >tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noEmit": true
  }
}
JSON
  cat >app.ts <<'TS'
import { Kirora, KiroraApiError, SDK_VERSION, type PushPermission } from '@kirora/web';

const kirora = new Kirora({ clientKey: 'kirora_pk_test', trackSessions: false });
kirora.track('Signup Started', { plan: 'pro' });
const permission: PushPermission = 'unanswered';
console.log(SDK_VERSION, permission, new KiroraApiError(429, undefined, 'x').retryable);
TS
  cat >check.mjs <<'JS'
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Construction must be safe where there's no browser, as in server rendering.
const { Kirora, SDK_VERSION } = await import('@kirora/web');
new Kirora({ clientKey: 'kirora_pk_test' }).track('Signup Started');
const worker = fileURLToPath(import.meta.resolve('@kirora/web/kirora-sw.js'));
if (!existsSync(worker)) throw new Error(`No service worker at ${worker}`);
console.log(`ok ${SDK_VERSION}`);
JS
  case $manager in
    npm) npm install --silent --no-audit --no-fund "$tarball" "${tools[@]}" ;;
    yarn1) npx -y yarn@1.22.22 add --silent "$tarball" "${tools[@]}" >/dev/null ;;
    yarn)
      touch yarn.lock
      "${yarn4[@]}" add "@kirora/web@file:$tarball" "${tools[@]}" >/dev/null
      ;;
    # esbuild is this check's own tool; @kirora/web has no install scripts.
    pnpm) pnpm add --silent --allow-build=esbuild "$tarball" "${tools[@]}" ;;
  esac
  # One check per line, so `set -e` stops at the first that fails.
  printf '%-6s ' "$manager"
  node_run check.mjs | tr '\n' ' '
  run tsc -p .
  printf 'types ok '
  run esbuild app.ts --bundle --format=esm --log-level=error --outfile=out.js
  printf 'bundle ok\n'
}

# All at once, each with its own output, reported in order.
pids=()
for manager in "${managers[@]}"; do
  (check "$manager" >"$work/$manager.log" 2>&1) &
  pids+=($!)
done
failed=0
for index in "${!managers[@]}"; do
  wait "${pids[$index]}" || failed=1
  cat "$work/${managers[$index]}.log"
done
exit "$failed"
