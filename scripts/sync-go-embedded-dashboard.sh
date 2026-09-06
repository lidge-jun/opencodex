#!/usr/bin/env bash
# Refresh the Go release binary's go:embed tree from the Vite dashboard build.
# This runs only on a release build host. A small checked-in snapshot remains so
# go build works for source users and CI without Bun installed.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
bun_bin="${OCX_BUN:-}"
if [ -z "$bun_bin" ]; then bun_bin="$(command -v bun || true)"; fi
if [ -z "$bun_bin" ]; then
  echo "sync-go-embedded-dashboard: Bun is required to build the release dashboard (set OCX_BUN)" >&2
  exit 1
fi
cd "$repo_root/gui"
"$bun_bin" install --frozen-lockfile
"$bun_bin" run build
[ -f dist/index.html ] || { echo "sync-go-embedded-dashboard: gui/dist/index.html missing after build" >&2; exit 1; }
target="$repo_root/go/internal/embeddedui/static"
find "$target" -mindepth 1 -delete
cp -R dist/. "$target/"
printf 'embedded dashboard refreshed from %s\n' "$repo_root/gui/dist"
