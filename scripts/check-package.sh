#!/usr/bin/env bash
# publint and Are the Types Wrong. Checks the tarball in $KIRORA_TARBALL if set (CI packs
# once for every check), otherwise packs one.
set -euo pipefail
publint --pack false
if [[ -n ${KIRORA_TARBALL:-} ]]; then target=("$KIRORA_TARBALL"); else target=(--pack .); fi
attw "${target[@]}" --profile esm-only --exclude-entrypoints kirora-sw.js
