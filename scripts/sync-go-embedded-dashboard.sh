#!/usr/bin/env bash
# Refresh the embedded dashboard build for a release ocx binary. The Vite
# output is staged into go/internal/embeddedui/static/assets/, which is
# gitignored: generated build output is never committed (matching the
# repository-wide gui/dist convention), and the release build of ./cmd/ocx
# picks the staged build up through go:embed.
#
# Checked-in static/ content stays source-only (the thin fallback page and the
# gui/public icon mirrors), so `go build` keeps working offline for source
# users and CI without Bun: the binary serves the staged build when present and
# the embedded fallback page otherwise.
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
# Overlay only the generated bundle into the embed tree. The static root keeps
# its tracked source files; assets/ is replaced wholesale because Vite hashes
# every filename on each build.
target="$repo_root/go/internal/embeddedui/static/assets"
rm -rf "$target"
mkdir -p "$target"
cp dist/assets/* "$target/"
cp dist/index.html "$repo_root/go/internal/embeddedui/static/index.html"
printf 'embedded dashboard refreshed from %s (assets staged in gitignored static/assets)\n' "$repo_root/gui/dist"
