#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "prepare-widget requires macOS." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$desktop_dir/.." && pwd)"
package_dir="$repo_root/app"
output_dir="$desktop_dir/src-tauri/widget/OpenCodexWidget.appex"
configuration="${CONFIGURATION:-release}"
universal="${UNIVERSAL:-1}"

if [[ "$universal" != "0" && "$universal" != "1" ]]; then
  echo "UNIVERSAL must be 0 or 1." >&2
  exit 1
fi

build_root="$(mktemp -d "${TMPDIR:-/tmp}/opencodex-widget.XXXXXX")"
cleanup() { rm -rf "$build_root"; }
trap cleanup EXIT

build_widget() {
  local arch="$1"
  local scratch="$build_root/$arch"
  swift build \
    --package-path "$package_dir" \
    --scratch-path "$scratch" \
    -c "$configuration" \
    --arch "$arch" \
    --product OpenCodexWidget
  swift build \
    --package-path "$package_dir" \
    --scratch-path "$scratch" \
    -c "$configuration" \
    --arch "$arch" \
    --show-bin-path
}

if [[ "$universal" == "1" ]]; then
  arm64_bin="$(build_widget arm64 | tail -n 1)/OpenCodexWidget"
  x86_64_bin="$(build_widget x86_64 | tail -n 1)/OpenCodexWidget"
  executable="$build_root/OpenCodexWidget"
  lipo -create "$arm64_bin" "$x86_64_bin" -output "$executable"
else
  executable="$(build_widget "$(uname -m)" | tail -n 1)/OpenCodexWidget"
fi

[[ -x "$executable" ]] || { echo "Swift build did not produce $executable" >&2; exit 1; }

rm -rf "$output_dir"
mkdir -p "$output_dir/Contents/MacOS"
cp "$executable" "$output_dir/Contents/MacOS/OpenCodexWidget"
cp "$package_dir/Widget-Info.plist" "$output_dir/Contents/Info.plist"

version="$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",/\1/p' "$desktop_dir/src-tauri/tauri.conf.json" | head -n 1)"
version_core="${version%%-*}"
[[ "$version_core" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "Invalid Tauri version: $version" >&2
  exit 1
}
plutil -replace CFBundleShortVersionString -string "$version_core" "$output_dir/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$version_core" "$output_dir/Contents/Info.plist"

if [[ -n "${MACOS_SIGN_IDENTITY:-}" ]]; then
  # Hardened runtime and a secure timestamp are both required for notarized Developer ID
  # software, and an extension that lacks either fails notarization with the host around it.
  codesign --force --sign "$MACOS_SIGN_IDENTITY" --entitlements "$package_dir/Widget.entitlements" \
    --options runtime --timestamp "$output_dir"
else
  codesign --force --sign - --entitlements "$package_dir/Widget.entitlements" \
    --timestamp=none "$output_dir"
fi

echo "$output_dir"
