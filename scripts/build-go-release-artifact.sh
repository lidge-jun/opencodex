#!/usr/bin/env bash
# Build one static Go ocx release candidate. This is a staging-only helper for
# #42: release.ts remains the release authority until #40 makes this artifact
# the complete single-binary distribution.
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
cd "$repo_root/go"
GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 \
  go build -buildvcs=false -trimpath -o "$output_dir/$filename" ./cmd/ocx
printf '%s\n' "$output_dir/$filename"
