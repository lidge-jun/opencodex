# Widget extension signing

Status: OPEN until the pull request lands on `dev`.

The macOS app would have installed with no widget, and nothing in the build would have said so.

## What was wrong

`macOS.files` in `desktop/src-tauri/tauri.conf.json` puts `PlugIns/OpenCodexWidget.appex` into the
bundle. The Tauri bundler copies it and never signs it: `copy_custom_files_to_bundle` in
tauri-bundler 2.5.0 writes the file and does not add it to `sign_paths`, which only ever holds
`Contents/MacOS`, `Contents/Frameworks` and the `.app` itself. There is no `--deep` anywhere in
that path. Whatever signature `build-widget.sh` leaves is therefore the signature that ships.

`build-widget.sh` left an ad-hoc one. Its signing branch keys on `MACOS_SIGN_IDENTITY`, and the
release workflow set that variable only on the `Build desktop bundles` step — the step *after* the
widget was built. `Build WidgetKit extension` carried no `env:` block at all, so the script always
took its `codesign --force --sign -` fallback, with `--timestamp=none` and no hardened runtime.

macOS does not register an extension signed that way, and notarization rejects any Mach-O in a
bundle that lacks the hardened runtime.

## What had not happened yet

No release has shipped a macOS app. v2.58, v2.59 and v2.60 all carry zero desktop assets, and the
`APPLE_*` secrets were added to the repository hours after the last release ran. The signed branch
of this script has never executed. This is a defect found before its first victim, not one being
recovered from — the next release is where it would have landed.

## The fix

The script resolves its signing identity before the Swift build, so a release that holds Developer
ID material and somehow has no identity fails in a second instead of after a universal build, and
never leaves a half-built unsigned appex behind. `WIDGET_SIGN_REQUIRED=1` makes that refusal the
behaviour whenever the workflow holds a certificate; the ad-hoc branch stays for local builds.

Signing walks every Mach-O the bundle actually contains, chosen by magic bytes rather than by name.
Today that set is one file. A suffix filter is the thing that fails silently when that stops being
true: a helper tool or an embedded dylib carries no extension to match, stays unsigned, and the
submission comes back "The binary is not signed with a valid Developer ID certificate" while the
containing bundle looks perfectly signed. Every signature now carries `--options runtime`, and the
script re-reads its own result and fails if the runtime flag is missing.

The workflow imports the certificate into a temporary keychain before the widget is built, because
codesign resolves an identity through the keychain search list and Tauri does not build its own
keychain until the bundling step. Tauri re-adds itself to the same search list, so the two do not
collide, and a cleanup step deletes the keychain on any outcome.

## Verification

Run locally on macOS 27 with Xcode 27.0 and a real Developer ID in the keychain.

- Signed path: `flags=0x10000(runtime)`, `Authority=Developer ID Application`, `TeamIdentifier`
  set, secure timestamp present, `com.apple.security.app-sandbox` preserved, and
  `codesign --verify --deep --strict` clean. `CFBundleShortVersionString` and `CFBundleVersion`
  both resolve to the Tauri version.
- Ad-hoc path with no identity: `flags=0x10002(adhoc,runtime)` — the hardened runtime is now on
  the local build too, so the two paths differ only in who signed.
- `WIDGET_SIGN_REQUIRED=1` with no identity: refuses in under a second, before the build.
- Bundle simulation: an `.app` holding the signed appex under `Contents/PlugIns`, signed the way
  Tauri signs — inner executables, then the bundle, no `--deep` — keeps the nested Developer ID
  signature, runtime flag, team identifier and entitlements intact, and
  `codesign --verify --deep --strict` reports `--validated:...OpenCodexWidget.appex`.
- The same simulation over an appex left unsigned fails outer signing with
  `In subcomponent: .../OpenCodexWidget.appex`.
- `tests/ci-workflows/release-desktop-scripts.test.ts` — 11 pass, binding the workflow wiring, the
  magic-byte sweep, the hardened runtime and its self-check, and the refusal.

End-to-end notarization of a full OpenCodex `.app` was not run; that needs a complete `tauri build`
and the release workflow is where it belongs.
