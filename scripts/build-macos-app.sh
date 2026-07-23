#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
package_dir="$repo_root/apps/macos-menu-bar"
output_root="${OUTPUT_DIR:-$repo_root/dist/macos}"
app_bundle="$output_root/OpenCodex.app"
configuration="${CONFIGURATION:-release}"
app_icon_source="$repo_root/gui/public/favicon.png"
menu_bar_icon_source="$repo_root/assets/logo-light.png"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build:macos requires macOS." >&2
  exit 1
fi

case "$app_bundle" in
  "$output_root"/*.app) ;;
  *)
    echo "Refusing to replace unexpected bundle path: $app_bundle" >&2
    exit 1
    ;;
esac

for resource in "$app_icon_source" "$menu_bar_icon_source"; do
  if [[ ! -f "$resource" ]]; then
    echo "Missing macOS app icon resource: $resource" >&2
    exit 1
  fi
done

swift_args=(--package-path "$package_dir" -c "$configuration" --product OpenCodexMenuBar)
if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  developer_dir="$(xcode-select -p 2>/dev/null || true)"
  if [[ "$developer_dir" == *"CommandLineTools"* ]]; then
    echo "UNIVERSAL=1 requires the full Xcode toolchain; Command Line Tools only has the current-architecture Swift compatibility libraries." >&2
    echo "Install Xcode, then run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
    exit 1
  fi
  swift_args+=(--arch arm64 --arch x86_64)
fi

swift build "${swift_args[@]}"
bin_dir="$(swift build "${swift_args[@]}" --show-bin-path)"

mkdir -p "$output_root"
staging_root="$(mktemp -d "$output_root/.OpenCodex-build.XXXXXX")"
staged_app="$staging_root/OpenCodex.app"
iconset="$staging_root/OpenCodex.iconset"
cleanup() {
  rm -rf "$staging_root"
}
trap cleanup EXIT

mkdir -p "$staged_app/Contents/MacOS" "$staged_app/Contents/Resources"
cp "$bin_dir/OpenCodexMenuBar" "$staged_app/Contents/MacOS/OpenCodexMenuBar"
cp "$package_dir/Info.plist" "$staged_app/Contents/Info.plist"

mkdir -p "$iconset"
retina_suffix="$(printf '\1002x')"
icon_specs=(
  "icon_16x16.png:16"
  "icon_16x16${retina_suffix}.png:32"
  "icon_32x32.png:32"
  "icon_32x32${retina_suffix}.png:64"
  "icon_128x128.png:128"
  "icon_128x128${retina_suffix}.png:256"
  "icon_256x256.png:256"
  "icon_256x256${retina_suffix}.png:512"
  "icon_512x512.png:512"
  "icon_512x512${retina_suffix}.png:1024"
)
for spec in "${icon_specs[@]}"; do
  filename="${spec%%:*}"
  size="${spec##*:}"
  sips --resampleHeightWidth "$size" "$size" "$app_icon_source" --out "$iconset/$filename" >/dev/null
done
iconutil --convert icns "$iconset" --output "$staged_app/Contents/Resources/OpenCodex.icns"
cp "$menu_bar_icon_source" "$staged_app/Contents/Resources/OpenCodexMenuBar.png"

package_version="$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",/\1/p' "$repo_root/package.json" | head -n 1)"
if [[ -n "$package_version" ]]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $package_version" "$staged_app/Contents/Info.plist"
fi

codesign --force --sign - "$staged_app" >/dev/null
rm -rf "$app_bundle"
mv "$staged_app" "$app_bundle"
echo "$app_bundle"
