#!/usr/bin/env bash
# Build one static Go ocx release candidate (ADR-0008 increment 7, ticket #42).
# The Go binary is the release runtime: this is the single artifact builder used
# by both .github/workflows/go-release-artifacts.yml (which verifies every
# release target) and release.yml (which attaches the built binaries to the
# release tag). release.ts remains the npm release authority; this script builds
# the companion TypeScript-free distribution artifact.
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/build-go-release-artifact.sh <goos>/<goarch> <output-directory>

Supported targets: linux/amd64, linux/arm64, darwin/amd64, darwin/arm64, windows/amd64
USAGE
  exit 64
}

[ "$#" -eq 2 ] || usage
target="$1"
output_dir="$2"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
case "$output_dir" in
  /*) ;;
  *) output_dir="$repo_root/$output_dir" ;;
esac
case "$target" in
  linux/amd64|linux/arm64|darwin/amd64|darwin/arm64|windows/amd64) ;;
  *) echo "unsupported Go release target: $target" >&2; usage ;;
esac

goos="${target%/*}"
goarch="${target#*/}"
filename="ocx-${goos}-${goarch}"
if [ "$goos" = windows ]; then
  filename="${filename}.exe"
fi

mkdir -p "$output_dir"
# The release artifact embeds the actual Vite output; source builds retain the checked-in fallback snapshot.
"$repo_root/scripts/sync-go-embedded-dashboard.sh"
version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$repo_root/package.json" | head -n 1)"
if [ -z "$version" ]; then
  echo "could not read package version for Go release artifact" >&2
  exit 1
fi
cd "$repo_root/go"
GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 \
  go build -buildvcs=false -trimpath -ldflags "-X main.version=$version" -o "$output_dir/$filename" ./cmd/ocx
printf '%s\n' "$output_dir/$filename"
