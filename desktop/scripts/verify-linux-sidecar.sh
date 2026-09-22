#!/usr/bin/env bash
# Run only on a Linux packaging runner, against the completed AppImage.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
bundle="$root/desktop/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage"
original="$root/desktop/src-tauri/binaries/ocx-x86_64-unknown-linux-gnu"
shopt -s nullglob
images=("$bundle"/*.AppImage)
if [ "${#images[@]}" -ne 1 ]; then
  echo "Expected exactly one completed AppImage" >&2
  exit 1
fi
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
cd "$scratch"
"${images[0]}" --appimage-extract > /dev/null
sidecar="$scratch/squashfs-root/usr/bin/ocx"
test ! -L "$sidecar"
cmp "$original" "$sidecar"
sha256sum "$original" "$sidecar"
mkdir "$scratch/home"
timeout 30s env OPENCODEX_HOME="$scratch/home" "$sidecar" --version
