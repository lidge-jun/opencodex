#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUN=${OCX_BUN_BIN:-}

if [ -z "$BUN" ] && command -v bun >/dev/null 2>&1; then
  BUN=$(command -v bun)
fi
if [ -z "$BUN" ] && [ -x /usr/local/lib/node_modules/@bitkyc08/opencodex/node_modules/bun/bin/bun.exe ]; then
  BUN=/usr/local/lib/node_modules/@bitkyc08/opencodex/node_modules/bun/bin/bun.exe
fi
if [ -z "$BUN" ]; then
  echo "Unable to find Bun. Set OCX_BUN_BIN to a Bun executable." >&2
  exit 1
fi

exec "$BUN" "$ROOT/scripts/local-update.ts" "$@"
