#!/usr/bin/env bash
set -euo pipefail

# Wraps OpenCodex.app for distribution.
#
# Every step is an assertion rather than a hope: a release asset that is produced but
# empty, unsigned, or missing its executable is worse than no asset at all, because the
# failure surfaces on the user's machine instead of in CI.

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
  echo "Invalid package version for the macOS release asset: '$package_version'" >&2
  exit 1
fi

# A release dispatched for one version must never package a different one.
if [[ -n "${RELEASE_VERSION:-}" && "$RELEASE_VERSION" != "$package_version" ]]; then
  echo "package.json ($package_version) does not match the requested release (${RELEASE_VERSION})" >&2
  exit 1
fi

if [[ "$universal" != "0" && "$universal" != "1" ]]; then
  echo "UNIVERSAL must be 0 or 1." >&2
  exit 1
fi

mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"

build_root="$(mktemp -d "${TMPDIR:-/tmp}/OpenCodex-release.XXXXXX")"
cleanup() { rm -rf "$build_root"; }
trap cleanup EXIT

OUTPUT_DIR="$build_root" UNIVERSAL="$universal" CONFIGURATION=release \
  bash "$script_dir/build-macos-app.sh" >&2

app_bundle="$build_root/OpenCodex.app"
executable="$app_bundle/Contents/MacOS/OpenCodexMenuBar"

codesign --verify --deep --strict --verbose=2 "$app_bundle"

# Report the Gatekeeper verdict rather than discovering it on a user's machine. An
# ad-hoc build is expected to be rejected; that is documented, not a packaging failure.
# A build that claimed a real identity and STILL fails assessment is a failure.
if spctl --assess --type execute "$app_bundle" >/dev/null 2>&1; then
  echo "==> Gatekeeper: accepted" >&2
else
  if [[ -n "${MACOS_SIGN_IDENTITY:-}" ]]; then
    echo "Signed with $MACOS_SIGN_IDENTITY but Gatekeeper still rejects the bundle." >&2
    echo "It likely needs notarization (notarytool) and a stapled ticket." >&2
    exit 1
  fi
  echo "==> Gatekeeper: rejected (expected for an ad-hoc signature)." >&2
  echo "    Users must right-click > Open on first launch; this is documented." >&2
fi

architectures="$(lipo -archs "$executable")"
if [[ "$universal" == "1" ]]; then
  for required_arch in arm64 x86_64; do
    if [[ " $architectures " != *" $required_arch "* ]]; then
      echo "Universal build is missing $required_arch (got: $architectures)" >&2
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

# ditto rather than zip: it preserves extended attributes and symlinks, so the unpacked
# bundle stays launchable. Plain zip corrupts the code signature.
ditto -c -k --sequesterRsrc --keepParent "$app_bundle" "$archive_path"

# An archive that exists but does not contain the executable is the failure mode this
# assertion exists to catch.
archive_entries="$(unzip -Z1 "$archive_path")"
if ! grep -Fqx 'OpenCodex.app/Contents/MacOS/OpenCodexMenuBar' <<< "$archive_entries"; then
  echo "Packaged archive does not contain the OpenCodex executable." >&2
  echo "Archive entries were:" >&2
  printf '%s\n' "$archive_entries" | head -20 >&2
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
