#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
output_dir="${RELEASE_OUTPUT_DIR:-$repo_root/dist/release}"
universal="${UNIVERSAL:-1}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "package:macos requires macOS." >&2
  exit 1
fi

package_version="$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",/\1/p' "$repo_root/package.json" | head -n 1)"
if [[ ! "$package_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid package version for macOS release asset: $package_version" >&2
  exit 1
fi
if [[ -n "${RELEASE_VERSION:-}" && "$RELEASE_VERSION" != "$package_version" ]]; then
  echo "package.json ($package_version) != requested release (${RELEASE_VERSION})" >&2
  exit 1
fi
if [[ "$universal" != "0" && "$universal" != "1" ]]; then
  echo "UNIVERSAL must be 0 or 1." >&2
  exit 1
fi

mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
build_root="$(mktemp -d "${TMPDIR:-/tmp}/OpenCodex-release.XXXXXX")"
cleanup() {
  rm -rf "$build_root"
}
trap cleanup EXIT

OUTPUT_DIR="$build_root" UNIVERSAL="$universal" CONFIGURATION=release \
  bash "$repo_root/scripts/build-macos-app.sh"

app_bundle="$build_root/OpenCodex.app"
executable="$app_bundle/Contents/MacOS/OpenCodexMenuBar"
codesign --verify --deep --strict --verbose=2 "$app_bundle"

architectures="$(lipo -archs "$executable")"
if [[ "$universal" == "1" ]]; then
  for required_arch in arm64 x86_64; do
    if [[ " $architectures " != *" $required_arch "* ]]; then
      echo "Universal build is missing $required_arch: $architectures" >&2
      exit 1
    fi
  done
  architecture_label="universal"
else
  architecture_label="${architectures// /-}"
fi

archive_name="OpenCodex-${package_version}-macos-${architecture_label}.zip"
checksum_name="${archive_name}.sha256"
archive_path="$output_dir/$archive_name"
checksum_path="$output_dir/$checksum_name"
rm -f "$archive_path" "$checksum_path"

ditto -c -k --sequesterRsrc --keepParent "$app_bundle" "$archive_path"
archive_entries="$(unzip -Z1 "$archive_path")"
if ! grep -Fqx 'OpenCodex.app/Contents/MacOS/OpenCodexMenuBar' <<< "$archive_entries"; then
  echo "Packaged archive does not contain the OpenCodex executable." >&2
  exit 1
fi
(
  cd "$output_dir"
  shasum -a 256 "$archive_name" > "$checksum_name"
)

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "archive_name=$archive_name"
    echo "checksum_name=$checksum_name"
  } >> "$GITHUB_OUTPUT"
fi

echo "$archive_path"
echo "$checksum_path"
