# 040 — Phase 4: universal build, release packaging, CI wiring

**Depends on:** `010`-`030` (there must be an app worth packaging). Phases 1-3 verify
themselves through `swift test` / `swift build` / `swift run`; **this phase owns the
bundle end to end** — `scripts/build-macos-app.sh` is introduced here and the first `.app`
is produced here.
**Independently verifiable by:** `lipo -archs` on the packaged executable, archive
content assertion, and workflow syntax validation.

This phase is the direct answer to the user's question — *"메뉴바는 못 넣는 거 아님? 앱을
만들어야 되는 거 아님?"* The app is only real when a user can download and run it without a
toolchain. Packaging architecture is inherited from PR #387 (`001` §5); it was the
strongest part of either PR and is not re-derived.

**Security note:** this phase edits `.github/workflows/release.yml`, which
`AGENTS.md` classifies as requiring explicit security review. Changes are therefore
minimal, additive, SHA-pinned, and least-privilege. No secret is introduced.

## Stale check at P

Re-verified against the tree: neither script existed, `package.json` had no macOS
entries, and `gui/public/favicon.png` (the icon source) is present. The CI path filter
also lacked `app/**`, so an app-only change would have run no CI at all — added.

## File change map

| Path | Action |
| --- | --- |
| `scripts/build-macos-app.sh` | NEW |
| `scripts/package-macos-release.sh` | NEW |
| `package.json` | MODIFY — three script entries |
| `.github/workflows/ci.yml` | MODIFY — path filter + macOS steps |
| `.github/workflows/release.yml` | MODIFY — `package-macos` job + asset attach |
| `.gitignore` | MODIFY — `dist/macos/` (already added in `010`) |

## `scripts/build-macos-app.sh`

Assembles the bundle by hand. No Xcode project, so nothing to keep in sync.

```bash
#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/app"
output_root="${OUTPUT_DIR:-$repo_root/dist/macos}"
configuration="${CONFIGURATION:-release}"

[[ "$(uname -s)" == "Darwin" ]] || { echo "build:macos requires macOS." >&2; exit 1; }

# The build DELETES whatever sits at the destination, so containment is a safety
# boundary. It took four attempts to get right, and each failure is why the final shape
# looks the way it does:
#
#   1. comparing $app_bundle against $output_root proved nothing — same variable;
#   2. `cd … && pwd` keeps LOGICAL paths, so a repo-local symlink pointing outside
#      satisfied the prefix check;
#   3. resolving physically BEFORE normalising let `..` reveal a symlink that was then
#      never followed — and `unset 'stack[-1]'` is a bad subscript in bash 3.2 (what
#      macOS ships), so `..` was silently never applied at all;
#   4. a RELATIVE dangling target was joined on without normalising, so
#      `link -> ../../outside` became `<repo>/../../outside`, passed the `<repo>/*`
#      check, and escaped during mkdir -p.
#
# resolve_physical therefore normalises lexically first (quoted array iteration, so a
# literal glob is not expanded), then resolves component by component, and refuses any
# symlink that does not resolve to an existing directory.
#
# ABBREVIATED. scripts/build-macos-app.sh is authoritative — in particular resolve_physical
# itself, and the $TMPDIR handling below, which matters because macOS puts TMPDIR under
# /var/folders rather than /tmp. A containment check that allowed only /tmp would reject
# the packaging script's own temporary build root.
output_root="$(resolve_physical "$output_root")"
allowed_root="$(cd "$repo_root" && pwd -P)"
allowed_tmp="$(cd "${TMPDIR%/}" 2>/dev/null && pwd -P || echo "")"
case "$output_root" in
  "$allowed_root"/*) ;;
  /private/tmp/*|/tmp/*) ;;
  *)
    if [[ -z "$allowed_tmp" || "$output_root" != "$allowed_tmp"/* ]]; then
      echo "Refusing to build into '$output_root'" >&2
      exit 1
    fi
    ;;
esac

# Only NOW create it, so a refused path leaves nothing behind.
mkdir -p "$output_root"
app_bundle="$output_root/OpenCodex.app"

swift_args=(--package-path "$package_dir" -c "$configuration" --product OpenCodexMenuBar)
if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  developer_dir="$(xcode-select -p 2>/dev/null || true)"
  if [[ "$developer_dir" == *"CommandLineTools"* ]]; then
    echo "UNIVERSAL=1 requires the full Xcode toolchain; Command Line Tools ships only" >&2
    echo "current-architecture Swift compatibility libraries." >&2
    echo "Install Xcode, then: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
    exit 1
  fi
  swift_args+=(--arch arm64 --arch x86_64)
fi

swift build "${swift_args[@]}"
bin_dir="$(swift build "${swift_args[@]}" --show-bin-path)"
```

**Every path is defined before use, and `output_root` exists before `mktemp` targets it.**
An earlier draft of this document called `mktemp` inside a directory it had not created,
used `$iconset` before defining it, and ran `plutil` against an `Info.plist` it never
copied — under `set -u` that script cannot run. The full sequence below is the executable
version.

**The CLT guard is not optional.** `001` §4.1 records the live probe on this machine:

```text
swift build --arch arm64 --arch x86_64 -c release
  -> ld: symbol(s) not found for architecture x86_64
swift build --arch arm64 -c release
  -> Build complete! (10.39 sec)
```

Without the guard, a contributor on Command Line Tools gets a linker error with no
explanation. PR #387 discovered this and its message is kept nearly verbatim.

Staging, then atomic swap:

```bash
# See the containment block above: validation happens before any mkdir.
staging_root="$(mktemp -d "$output_root/.OpenCodex-build.XXXXXX")"
staged_app="$staging_root/OpenCodex.app"
iconset="$staging_root/OpenCodex.iconset"
trap 'rm -rf "$staging_root"' EXIT

mkdir -p "$staged_app/Contents/MacOS" "$staged_app/Contents/Resources"
cp "$bin_dir/OpenCodexMenuBar" "$staged_app/Contents/MacOS/OpenCodexMenuBar"
cp "$package_dir/Info.plist" "$staged_app/Contents/Info.plist"

# Version comes from package.json — the app can never claim a version the release did not ship.
version="$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",/\1/p' "$repo_root/package.json" | head -n 1)"
# Apple constrains both fields, and differently from the npm version string:
#   CFBundleShortVersionString - exactly three integers (no prerelease suffix)
#   CFBundleVersion            - ONE TO THREE integers; a fourth is ignored, so
#                                appending a run number to a full semver adds nothing
version_core="${version%%-*}"
build_version="${MACOS_BUILD_NUMBER:-$version_core}"
plutil -replace CFBundleShortVersionString -string "$version_core"   "$staged_app/Contents/Info.plist"
plutil -replace CFBundleVersion            -string "$build_version" "$staged_app/Contents/Info.plist"

# Icon: reuse the existing dashboard favicon, no new binary asset in the repo.
icon_source="$repo_root/gui/public/favicon.png"
[[ -f "$icon_source" ]] || { echo "Missing icon source: $icon_source" >&2; exit 1; }
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size"           "$icon_source" --out "$iconset/icon_${size}x${size}.png"      >/dev/null
  sips -z "$((size*2))" "$((size*2))" "$icon_source" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$staged_app/Contents/Resources/OpenCodex.icns"

# MACOS_SIGN_IDENTITY is a LOCAL hook (preconfigured keychain). CI deliberately does not
# set it: an identity name alone cannot sign on a hosted runner, because nothing imports
# the certificate and private key. Unset, the bundle is ad-hoc signed and says so.
if [[ -n "${MACOS_SIGN_IDENTITY:-}" ]]; then
  codesign --force --deep --options runtime --timestamp --sign "$MACOS_SIGN_IDENTITY" "$staged_app"
else
  codesign --force --sign - --timestamp=none "$staged_app"
fi

# Refuse to delete a symlinked destination.
if [[ -L "$app_bundle" ]]; then
  echo "Refusing to replace '$app_bundle': it is a symlink." >&2
  exit 1
fi

rm -rf "$app_bundle" && mv "$staged_app" "$app_bundle"
```

Building into a temp dir and moving at the end means an interrupted build never leaves a
half-written `.app` that launches and misbehaves.

## `scripts/package-macos-release.sh`

Wraps the bundle for distribution. Every step is an assertion, not a hope.

```bash
RELEASE_VERSION guard   # package.json must equal the requested release version
UNIVERSAL=1 CONFIGURATION=release bash scripts/build-macos-app.sh
codesign --verify --deep --strict --verbose=2 "$app_bundle"
lipo -archs "$executable"                 # must contain arm64 AND x86_64 when UNIVERSAL=1
ditto -c -k --sequesterRsrc --keepParent "$app_bundle" "$archive_path"
unzip -Z1 "$archive_path" | grep -Fqx 'OpenCodex.app/Contents/MacOS/OpenCodexMenuBar'
shasum -a 256 "$archive_name" > "$checksum_name"
```

Output: `OpenCodex-<version>-macos-universal.zip` + `.sha256`.

`ditto` rather than `zip`: it preserves extended attributes and symlinks, so the unpacked
bundle stays launchable. Plain `zip` corrupts code signatures. The `unzip -Z1` assertion
catches the case where the archive is produced but empty.

## `package.json`

```json
"build:macos":   "bash scripts/build-macos-app.sh",
"package:macos": "bash scripts/package-macos-release.sh",
"test:macos":    "swift run --package-path app MenuBarCoreTests && swift run --package-path app MenuBarUITests"
```

## `.github/workflows/ci.yml`

Path filter gains `"app/**"` in both the `pull_request` and `push` blocks. New steps in
the existing cross-platform job, gated so Linux and Windows runners skip them:

```yaml
- name: Test macOS menu bar app
  if: runner.os == 'macOS'
  run: bun run test:macos

- name: Build macOS menu bar app
  if: runner.os == 'macOS'
  run: bun run build:macos
```

Placed after `privacy:scan` so a credential leak fails before a long Swift build runs.

## `.github/workflows/release.yml`

### Current state (read before editing)

The workflow declares **workflow-level** permissions at lines 32-35:

```yaml
permissions:
  contents: write   # create the GitHub Release + tag after npm publish
  actions: read     # verify the release commit passed Cross-platform CI
  id-token: write   # OIDC for Trusted Publishing + provenance
```

Workflow-level permissions are **inherited by every job**. A `package-macos` job added
without its own `permissions:` block would silently run with `contents: write` and
`id-token: write` — an OIDC-capable token in a job that builds third-party-toolchain
code. An earlier draft of this document claimed the job "needs no `id-token`, no
`contents: write`" while specifying no block that would achieve that.

### Job graph

Three jobs, with npm independence preserved by construction:

```text
publish (existing)         package-macos (new)
   npm + GitHub Release        build + zip + sha256
          \                        /
           \                      /
            attach-macos (new, needs: [publish, package-macos])
                 upload assets to the existing Release
```

`publish` gains no `needs`, so a Swift or packaging failure **cannot** block or fail the
npm publish. `attach-macos` runs only when both succeed. If npm publishes but packaging
fails, the release is still valid and the asset is attached by re-running the workflow's
packaging path — documented in the guide as the retry procedure.

### The jobs

```yaml
package-macos:
  runs-on: macos-latest
  timeout-minutes: 20
  permissions:
    contents: read            # explicit: drops the inherited write + id-token
  outputs:
    archive_name:  ${{ steps.package.outputs.archive_name }}
    checksum_name: ${{ steps.package.outputs.checksum_name }}
  steps:
    - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7
      with:
        persist-credentials: false
    - id: package
      env:
        RELEASE_VERSION: ${{ inputs.version }}
        UNIVERSAL: "1"
        # A valid single-integer CFBundleVersion. Appending a run number to a full
        # semver would be a FOURTH component, which Apple ignores.
        MACOS_BUILD_NUMBER: ${{ github.run_number }}
      run: bash scripts/package-macos-release.sh
    - uses: actions/upload-artifact@330a01c490aca151604b8cf639adc76d48f6c5d4 # v5.0.0
      with:
        name: macos-release
        path: dist/release/
        if-no-files-found: error
        retention-days: 7

attach-macos:
  runs-on: ubuntu-latest
  needs: [publish, package-macos]
  if: ${{ inputs.dry-run != true }}
  timeout-minutes: 10
  permissions:
    contents: write           # only to attach assets to the existing Release
  steps:
    - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
      with:
        name: macos-release
        path: dist/release
    - name: Verify checksum before upload
      run: cd dist/release && shasum -a 256 -c *.sha256
    - name: Attach to release
      env:
        GH_TOKEN: ${{ github.token }}
        # Inputs reach shell code through env. Direct interpolation into run: source is
        # rejected repo-wide by tests/ci-workflows.test.ts.
        RELEASE_VERSION: ${{ inputs.version }}
      run: gh release upload "v${RELEASE_VERSION}" dist/release/* --clobber
```

`shasum -c` before upload means a corrupted artifact transfer cannot become a published
asset. `if: ${{ inputs.dry-run != true }}` keeps dry runs from touching a real Release. The
input is named `dry-run` with a hyphen (`release.yml:22-26`); `inputs.dry_run` would
resolve to null and the guard would silently pass, which is the exact failure this line
exists to prevent.

**`UNIVERSAL: "1"` is safe here specifically because `macos-latest` carries a full
Xcode**, the environment `001` §4.1 identified as the only one that can produce both
slices. This is why the universal assertion lives in CI and not in the local gate.

Constraints honoured:

- Every action pinned to a full commit SHA, including the two new ones above
  (`AGENTS.md` treats mutable third-party refs as a release blocker).
- Each new job declares explicit least-privilege `permissions`, overriding inheritance.
- `persist-credentials: false` on the packaging checkout.
- The npm publish path gains no new dependency.

## Privacy and artifact hygiene

`bun run privacy:scan` must pass. Concretely:

- `app/.gitignore` excludes `.build/`, `.swiftpm/`, `DerivedData/` (landed in `010`).
- Root `.gitignore` excludes `dist/macos/`.
- `git ls-files app/ | grep -E '\.build/|DerivedData/'` must return empty.
- No absolute developer path appears in **any file this unit adds or modifies** — checked
  explicitly rather than assumed. Pre-existing paths in unrelated historical devlogs are
  out of scope (`000` criterion 8). This mirrors the artifact defect the Codex reviewer
  originally raised on PR #421, which that contributor has since fixed (`001` §2.1).

## Implementation notes

**A pipeline subtlety cost a real debugging pass.** The archive assertion was originally
`unzip -Z1 "$archive" | grep -Fqx '…'`. Under `set -o pipefail`, `grep -q` exits as soon
as it matches; `unzip` *can* then receive SIGPIPE while still writing, and the pipeline
reports failure even though the match succeeded — which is how a correctly packaged
archive got rejected with "does not contain the OpenCodex executable". It is a race, not
a certainty: a reviewer re-running the old pipeline against the same archive saw it exit
0. That is precisely why it is worth fixing rather than dismissing — an assertion that
fails intermittently on success is worse than one that fails consistently. Capturing the
listing into a variable first and matching against a here-string removes the pipeline.

**`--sequesterRsrc` adds `__MACOSX/` entries** alongside the real paths, which is
harmless for an exact-match assertion but surprising when reading the listing by eye.

### Verified locally

```text
bash scripts/build-macos-app.sh
  -> dist/macos/OpenCodex.app (version 2.7.35), arm64
  -> Info.plist: CFBundleExecutable=OpenCodexMenuBar, CFBundlePackageType=APPL,
     CFBundleIconFile=OpenCodex, LSUIElement=true, NSAllowsLocalNetworking=true
  -> codesign --verify --deep --strict: valid on disk, satisfies its Designated Requirement
  -> launched from the bundle: menu bar item appeared, no ATS errors in the log

UNIVERSAL=0 bash scripts/package-macos-release.sh
  -> OpenCodex-2.7.35-macos-arm64.zip (813 KB) + .sha256
  -> shasum -a 256 -c: OK
  -> unpacked with ditto -x -k: signature survived, app launched from the unpacked bundle

UNIVERSAL=1 bash scripts/build-macos-app.sh
  -> refused with the Command Line Tools explanation rather than a linker error
```

The unpack-and-launch step is the one that matters: it is the path a user actually takes,
and it is the one that would expose a `zip`-corrupted signature.

## Signing and Gatekeeper: what actually ships

The asset is **ad-hoc signed**, and `spctl --assess --type execute` rejects it. That is
not an oversight to paper over — Developer ID signing plus notarization requires a paid
Apple Developer account, and this project has no certificate today:

```text
security find-identity -v -p codesigning | grep -c "Developer ID Application"  -> 0
grep -rn "APPLE_\|NOTARY\|DEVELOPER_ID" .github/workflows/                     -> none
```

So the scripts are built to be honest about it and ready for the day that changes:

- `MACOS_SIGN_IDENTITY` (optional) switches `build-macos-app.sh` to
  `codesign --options runtime --timestamp --sign "$identity"`, which is what
  notarization requires. Unset, it ad-hoc signs and says so on stderr.
- `package-macos-release.sh` runs `spctl --assess` and reports the verdict. An ad-hoc
  rejection is expected and non-fatal; a build that claimed a real identity and *still*
  fails assessment exits non-zero, because that means notarization is missing.
- `release.yml` deliberately does **not** pass `MACOS_SIGN_IDENTITY`. An identity name
  alone cannot sign on a hosted runner: nothing imports the certificate and private key,
  so `codesign` fails with "no identity found". Advertising the secret would imply a
  capability that does not exist. Real CI signing means a protected P12 import, a
  temporary keychain, `notarytool` credentials, and stapling — one security-reviewed
  change, not a lone secret.

**Consequence for Phase 5 docs:** the Gatekeeper section is not optional. Users will see
"cannot be opened because the developer cannot be verified" and need the right-click →
Open path. Documenting that honestly is better than shipping an asset that appears
broken.

## Accept criteria

1. `bun run build:macos` produces a launchable `dist/macos/OpenCodex.app`.
2. `bun run package:macos` produces zip + `.sha256`, with the content assertion passing.
3. `lipo -archs` shows `arm64` locally; both arches asserted in CI.
   3a. Both version fields honour Apple's limits: `CFBundleShortVersionString` is
       exactly three integers (`2.7.36-preview.1` → `2.7.36`), and `CFBundleVersion` is
       one to three integers — `MACOS_BUILD_NUMBER` replaces it outright rather than
       appending a fourth component, which Apple ignores.
   3b. `OUTPUT_DIR` outside the repository or temp is refused, since the build deletes
       whatever sits at the destination. Covered by `tests/macos-build-script.test.ts`,
       **8 cases** — six refusals, each asserting that nothing is created, and two
       acceptances:

       1. a sibling-of-repository path
       2. an unresolved `..` traversal
       3. a symlink revealed by a `..`
       4. a symlink pointing outside the permitted roots
       5. a symlink with a *relative* escaping target
       6. a literal glob, run from a directory containing a matching entry
       7. a repository path (accepted)
       8. a temp path (accepted)

       Three harness details are load-bearing, each learned by getting it wrong:

       - The outside path is a **sibling of the repository**, not anything under `$HOME`.
         Other suites replace `HOME` with a temp directory, and temp is a permitted root,
         so a `HOME`-derived path made this test pass alone and fail in the full suite.
       - The traversal fixture is built by **string concatenation**, never `path.join()`,
         which normalises `..` itself — with `join()` the test passed against the broken
         resolver.
       - The glob case runs the child in a directory that **contains a matching entry**.
         With `cwd` at the repository root and the glob under `dist/`, the old unquoted
         loop had nothing to expand and the test passed against the broken implementation.
4. `UNIVERSAL=1` under Command Line Tools fails with the explanatory message, not a
   linker error.
5. The build script runs end to end on a clean checkout under `set -euo pipefail`, with
   every variable defined before use.
6. Workflow YAML parses; all actions SHA-pinned to a full commit SHA.
   Note: "build clean" means exit 0, not warning-free — Command Line Tools emits
   framework search-path warnings that come from the toolchain, not from this code.
7. **Security review evidence recorded** before this phase closes (`MAINTAINERS.md`
   requires it for release automation): the final workflow diff reviewed, effective
   per-job permissions enumerated and confirmed least-privilege, every action pin
   resolved to an immutable SHA, dry-run behaviour confirmed not to touch a Release, and
   the npm-publish path confirmed to have gained no new failure dependency.
8. `bun run typecheck`, `bun run test`, `bun run privacy:scan` green.
9. No build artifacts tracked by git.
