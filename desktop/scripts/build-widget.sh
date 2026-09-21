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

# A widget extension is loaded by the system, not by the app, so it is validated on its own
# terms: notarization rejects any Mach-O inside it that lacks the hardened runtime, and macOS
# refuses to register an extension whose signature does not chain to the containing app's team.
# An ad-hoc signature satisfies neither, and the ad-hoc branch is the default whenever no
# identity reaches this script. Resolve that before the build so a misconfigured release fails
# in a second rather than after a universal Swift build.
if [[ -n "${MACOS_SIGN_IDENTITY:-}" ]]; then
  sign_identity="$MACOS_SIGN_IDENTITY"
  timestamp_arg=(--timestamp)
elif [[ "${WIDGET_SIGN_REQUIRED:-0}" == "1" ]]; then
  # A release that signs everything else and ad-hoc signs the widget produces an app that
  # ships either way and simply has no widget. Refuse instead.
  echo "WIDGET_SIGN_REQUIRED=1 but MACOS_SIGN_IDENTITY is empty; refusing to ad-hoc sign a release widget." >&2
  exit 1
else
  sign_identity="-"
  timestamp_arg=(--timestamp=none)
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

# Sign inside out over every Mach-O the bundle actually contains, chosen by magic bytes rather
# than by name. Today that set is the single widget executable, but a name or extension filter
# is the thing that fails silently when it stops being true: a helper tool or an embedded
# dylib carries no suffix to match, stays unsigned, and the whole submission comes back
# "The binary is not signed with a valid Developer ID certificate" with the bundle itself
# looking perfectly signed.
mach_o_members=()
while IFS= read -r candidate; do
  [[ "$(file -b "$candidate")" == *"Mach-O"* ]] || continue
  mach_o_members+=("$candidate")
done < <(find "$output_dir" -type f -not -path "*/_CodeSignature/*")

[[ ${#mach_o_members[@]} -gt 0 ]] || { echo "No Mach-O binary found in $output_dir" >&2; exit 1; }

for member in "${mach_o_members[@]}"; do
  codesign --force --sign "$sign_identity" --options runtime "${timestamp_arg[@]}" "$member"
done

# The bundle seal goes on last and is the only signature that carries the entitlements.
codesign --force --sign "$sign_identity" --entitlements "$package_dir/Widget.entitlements" \
  --options runtime "${timestamp_arg[@]}" "$output_dir"

codesign --verify --deep --strict "$output_dir"
# `runtime` is 0x10000 in the code directory flags. Asserting it here is what turns a silently
# unnotarizable widget into a failed build. The output is captured rather than piped into a
# matcher: `set -o pipefail` plus a matcher that exits on its first hit makes codesign die of
# SIGPIPE, and the check then fails on exactly the signatures it was meant to accept.
signature_display="$(codesign --display --verbose=4 "$output_dir" 2>&1)"
case "$signature_display" in
  *"flags="*"runtime"*) ;;
  *)
    echo "Widget signature is missing the hardened runtime:" >&2
    echo "$signature_display" >&2
    exit 1
    ;;
esac

echo "$output_dir"
