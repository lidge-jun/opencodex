#!/usr/bin/env bash
set -euo pipefail

# Assembles OpenCodex.app by hand.
#
# No Xcode project, so there is nothing to keep in sync with the package manifest. The
# bundle is staged in a temp directory and moved into place at the end, so an interrupted
# build never leaves a half-written .app that launches and misbehaves.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
package_dir="$repo_root/app"
output_root="${OUTPUT_DIR:-$repo_root/dist/macos}"
configuration="${CONFIGURATION:-release}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build:macos requires macOS." >&2
  exit 1
fi

# Validate BEFORE creating anything, so the script cannot leave a directory behind at a
# path it then refuses to build into.
#
# `cd … && pwd` keeps LOGICAL paths on macOS, so a symlink inside the repository that
# points elsewhere would satisfy the prefix check below and then be deleted for real.
# Resolve physically: walk up to the nearest existing ancestor, resolve that, and
# re-append the parts that do not exist yet.
resolve_physical() {
  local target="$1" part resolved
  # Absolute-ise relative input against the caller's directory.
  [[ "$target" = /* ]] || target="$PWD/$target"

  # ORDER MATTERS, and getting it wrong has been a bypass twice.
  #
  # 1. Normalise lexically FIRST. Resolving physically first and normalising afterwards
  #    lets `..` reveal a symlink that is then never physically resolved — so
  #    <repo>/.missing/../some-symlink passed containment while pointing elsewhere.
  # 2. THEN walk up to the nearest existing ancestor of the normalised path and resolve
  #    that with `pwd -P`, which follows any symlinks that survived normalisation.
  #
  # Iteration is over a quoted array, never `for part in $tail`: word splitting there
  # let a literal glob such as `rel*` expand against the filesystem.
  local -a parts=() stack=()
  local IFS=/
  read -r -a parts <<< "$target"
  unset IFS

  for part in "${parts[@]}"; do
    case "$part" in
      "" | ".") continue ;;
      "..")
        # `unset 'stack[-1]'` is a bad subscript in bash 3.2 (what macOS ships), so it
        # silently failed and `..` was never applied. Compute the index instead.
        if [[ ${#stack[@]} -gt 0 ]]; then
          unset "stack[$(( ${#stack[@]} - 1 ))]"
          stack=("${stack[@]}")
        fi
        ;;
      *) stack+=("$part") ;;
    esac
  done

  # Now resolve physically, component by component, so a symlink ANYWHERE along the
  # surviving path is followed — including one that only became reachable because a
  # `..` removed a non-existent parent above it.
  #
  # Resolving only the nearest existing ancestor is not enough: for
  # <repo>/.missing/../outward-link the ancestor is <repo>, and the trailing
  # `outward-link` symlink was re-appended unresolved and never followed.
  resolved="/"
  for part in "${stack[@]}"; do
    local candidate="${resolved%/}/$part"
    if [[ -L "$candidate" && ! -d "$candidate" ]]; then
      # A symlink that is not a directory: dangling, or pointing at a file. Following it
      # lexically was the third bypass here — a link to `../../outside` produced
      # `<repo>/../../outside`, which satisfied the `<repo>/*` prefix check and then
      # escaped during `mkdir -p`. There is no legitimate reason for OUTPUT_DIR to pass
      # through such a link, so refuse instead of trying to be clever.
      echo "Refusing to build through '$candidate': it is a symlink that does not" >&2
      echo "resolve to an existing directory." >&2
      exit 1
    fi
    if [[ -d "$candidate" ]]; then
      # `cd … && pwd -P` follows the symlink and any chain behind it.
      resolved="$(cd "$candidate" && pwd -P)"
    else
      resolved="${resolved%/}/$part"
    fi
  done
  printf '%s' "$resolved"
}

output_root="$(resolve_physical "$output_root")"
app_bundle="$output_root/OpenCodex.app"

# The build deletes whatever sits at $app_bundle, so the destination must be somewhere
# this project owns. Comparing $app_bundle against $output_root proves nothing — both
# come from the same variable, so pointing OUTPUT_DIR at /Applications would have passed
# and then recursively removed a real app.
allowed_root="$(cd "$repo_root" && pwd -P)"
if [[ -n "${TMPDIR:-}" ]]; then
  allowed_tmp="$(cd "${TMPDIR%/}" 2>/dev/null && pwd -P || echo "")"
else
  allowed_tmp=""
fi
case "$output_root" in
  "$allowed_root"/*) ;;
  /private/tmp/*|/tmp/*) ;;
  *)
    if [[ -z "$allowed_tmp" || "$output_root" != "$allowed_tmp"/* ]]; then
      echo "Refusing to build into '$output_root': it is outside the repository and the" >&2
      echo "temp directory. Set OUTPUT_DIR to a path under $repo_root." >&2
      exit 1
    fi
    ;;
esac

mkdir -p "$output_root"

swift_args=(--package-path "$package_dir" -c "$configuration" --product OpenCodexMenuBar)
widget_swift_args=(--package-path "$package_dir" -c "$configuration" --product OpenCodexWidget)

if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  developer_dir="$(xcode-select -p 2>/dev/null || true)"
  if [[ "$developer_dir" == *"CommandLineTools"* ]]; then
    echo "UNIVERSAL=1 requires the full Xcode toolchain; Command Line Tools ships only" >&2
    echo "current-architecture Swift compatibility libraries, so the x86_64 slice cannot" >&2
    echo "link. Install Xcode, then:" >&2
    echo "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
    exit 1
  fi
  swift_args+=(--arch arm64 --arch x86_64)
  widget_swift_args+=(--arch arm64 --arch x86_64)
fi

echo "==> Building ($configuration)…"
swift build "${swift_args[@]}"
swift build "${widget_swift_args[@]}"
bin_dir="$(swift build "${swift_args[@]}" --show-bin-path)"
executable="$bin_dir/OpenCodexMenuBar"
widget_bin_dir="$(swift build "${widget_swift_args[@]}" --show-bin-path)"
widget_executable="$widget_bin_dir/OpenCodexWidget"

if [[ ! -x "$executable" ]]; then
  echo "Build did not produce an executable at $executable" >&2
  exit 1
fi
if [[ ! -x "$widget_executable" ]]; then
  echo "Build did not produce an executable at $widget_executable" >&2
  exit 1
fi

staging_root="$(mktemp -d "$output_root/.OpenCodex-build.XXXXXX")"
staged_app="$staging_root/OpenCodex.app"
iconset="$staging_root/OpenCodex.iconset"
cleanup() { rm -rf "$staging_root"; }
trap cleanup EXIT

mkdir -p "$staged_app/Contents/MacOS" "$staged_app/Contents/Resources"
cp "$executable" "$staged_app/Contents/MacOS/OpenCodexMenuBar"
cp "$package_dir/Info.plist" "$staged_app/Contents/Info.plist"
appex="$staged_app/Contents/PlugIns/OpenCodexWidget.appex"
mkdir -p "$appex/Contents/MacOS"
cp "$widget_executable" "$appex/Contents/MacOS/OpenCodexWidget"
cp "$package_dir/Widget-Info.plist" "$appex/Contents/Info.plist"

# The app version comes from package.json, so it can never claim a version the release
# did not ship.
version="$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",/\1/p' "$repo_root/package.json" | head -n 1)"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Could not read a valid version from package.json: '$version'" >&2
  exit 1
fi

# Apple constrains BOTH version fields, and differently from the npm version string:
#
#   CFBundleShortVersionString - three period-separated integers. A prerelease suffix
#                                like "-preview.1" is not valid here.
#   CFBundleVersion            - ONE TO THREE period-separated integers. A fourth
#                                component is ignored, so appending a build number to a
#                                full semver produces no additional identity at all.
#
# So the short version is the numeric core, and when CI supplies a run number it becomes
# the CFBundleVersion outright — a monotonically increasing single integer is both valid
# and genuinely distinguishing, which "2.7.36.<run>" would not have been.
version_core="${version%%-*}"
if [[ ! "$version_core" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version core must be three integers for CFBundleShortVersionString: '$version_core'" >&2
  exit 1
fi

if [[ -n "${MACOS_BUILD_NUMBER:-}" ]]; then
  if [[ ! "$MACOS_BUILD_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "MACOS_BUILD_NUMBER must be a positive integer, got '$MACOS_BUILD_NUMBER'" >&2
    exit 1
  fi
  build_version="$MACOS_BUILD_NUMBER"
else
  build_version="$version_core"
fi
if [[ ! "$build_version" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]]; then
  echo "CFBundleVersion must be one to three integers, got '$build_version'" >&2
  exit 1
fi

plutil -replace CFBundleShortVersionString -string "$version_core" "$staged_app/Contents/Info.plist"
plutil -replace CFBundleVersion            -string "$build_version" "$staged_app/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$version_core" "$appex/Contents/Info.plist"
plutil -replace CFBundleVersion            -string "$build_version" "$appex/Contents/Info.plist"

# Icon: reuse the dashboard favicon rather than adding another binary asset to the repo.
icon_source="$repo_root/gui/public/favicon.png"
if [[ ! -f "$icon_source" ]]; then
  echo "Missing icon source: $icon_source" >&2
  exit 1
fi
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$icon_source" \
    --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$icon_source" \
    --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$staged_app/Contents/Resources/OpenCodex.icns"

# Signing.
#
# MACOS_SIGN_IDENTITY selects a Developer ID Application certificate already present in
# the caller's keychain and enables the hardened runtime, which is what notarization
# requires. It is a LOCAL hook: CI does not set it, because an identity name alone
# cannot sign on a hosted runner — nothing imports the certificate and private key, so
# codesign fails with "no identity found". Wiring CI signing properly means a protected
# P12 import, a temporary keychain, notarytool credentials, and stapling.
#
# Without it the bundle is ad-hoc signed: structurally valid, but `spctl --assess`
# rejects it and a downloaded copy shows "cannot be opened because the developer cannot
# be verified". The project has no Developer ID certificate today, so ad-hoc is what
# ships and the docs must carry the right-click-Open path rather than pretend
# otherwise.
#
# The widget reads the host snapshot through its own bundle container fallback path.
# App Groups require a team-ID-prefixed group and a Developer ID / team-signed extension;
# ad-hoc signatures cannot satisfy that requirement, so the widget uses its own container.
if [[ -n "${MACOS_SIGN_IDENTITY:-}" ]]; then
  codesign --force --options runtime --timestamp \
    --entitlements "$package_dir/Widget.entitlements" \
    --sign "$MACOS_SIGN_IDENTITY" "$appex"
  codesign --force --deep --options runtime --timestamp \
    --sign "$MACOS_SIGN_IDENTITY" "$staged_app"
  echo "==> Signed with $MACOS_SIGN_IDENTITY (hardened runtime)"
else
  codesign --force --sign - --entitlements "$package_dir/Widget.entitlements" \
    --timestamp=none "$appex"
  codesign --force --sign - --timestamp=none "$staged_app"
  echo "==> Ad-hoc signed (no MACOS_SIGN_IDENTITY): Gatekeeper will require the" >&2
  echo "    right-click-Open path on first launch." >&2
fi

if [[ -L "$app_bundle" ]]; then
  echo "Refusing to replace '$app_bundle': it is a symlink." >&2
  exit 1
fi
rm -rf "$app_bundle"
mv "$staged_app" "$app_bundle"

echo "==> Built $app_bundle (release $version, short $version_core, build $build_version)"
lipo -archs "$app_bundle/Contents/MacOS/OpenCodexMenuBar"
lipo -archs "$app_bundle/Contents/PlugIns/OpenCodexWidget.appex/Contents/MacOS/OpenCodexWidget"
