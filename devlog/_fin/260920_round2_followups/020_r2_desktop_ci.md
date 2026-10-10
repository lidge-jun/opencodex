# R2 — the `macos widget + bundle` failure on `dev`

Status: the job had two independent defects stacked on top of each other. The second was
invisible until the first was fixed, because it lived in a step that had never once executed.

## First layer: the verification build demanded the release key

`bundle.createUpdaterArtifacts` is on and the updater public key is committed, so `tauri build`
concluded it had to emit a signed update artifact and stopped with `A public key has been found,
but no private key`. On macOS this bites even with `--bundles app`, because the macOS updater
artifact is derived from the `.app` itself.

#5338 scoped the opt-out to the verification build with a `--config` override and left
`tauri.conf.json` alone, so release signing stays in `release.yml` where the secret lives.
`BundleConfig` carries `deny_unknown_fields`, so a misspelled override key fails the build
rather than silently reverting to signing — the override cannot rot into a no-op.

## Second layer: the Verify step asserted a filename that never existed

With the build green the Verify step ran for the first time and failed on its first line,
`test -x "$app/Contents/MacOS/OpenCodex"`, printing nothing because `test` is silent.

Tauri renames the main binary only when `mainBinaryName` is set (`tauri-cli`
`src/interface/mod.rs`, with `rename_app` in `src/interface/rust/desktop.rs` a no-op
otherwise). This config does not set it, so the bundled executable keeps the Cargo bin name
`opencodex-desktop`. The job log had said so all along: `Built application at:
.../target/release/opencodex-desktop`.

The fix reads `CFBundleExecutable` from the bundle's own `Info.plist`. `tauri-bundler`
`create_info_plist` writes that key from the same `main_binary_name()` that
`copy_binaries_to_bundle` uses for the filename, so the plist and the file on disk cannot
disagree. An empty value is rejected so a missing key cannot pass by testing the `MacOS`
directory.

The other three assertions were checked against the same source and were already correct:
`Settings::copy_binaries` strips the `-<target>` suffix so the sidecar lands as
`Contents/MacOS/ocx`, and `copy_custom_files_to_bundle` resolves `bundle.macOS.files`
relative to `Contents` and errors when the source is missing, so the appex is present with its
executable bit intact.

## What this leaves open

CI no longer exercises updater bundling at all. A regression there surfaces only during a
release. Two release-time backstops contain it — `collect-release-assets.ts` throws when the
macOS `app.tar.gz` is missing, and `updater-manifest.ts --require-all` refuses a partially
signed `latest.json` — and both are covered by `tests/ci-workflows/release-desktop-scripts.test.ts`.
What nothing covers is `tauri.conf.json` itself: no test reads it, so flipping
`createUpdaterArtifacts` off or mangling the `plugins.updater` block stays green everywhere
until a release runs. A static contract test over that file is the cheap follow-up.

The macOS updater filename is also restated by hand in four places —
`collect-release-assets.ts`, `updater-manifest.ts`, the `release.yml` matrix, and
`structure/desktop-shell.md` — with nothing deriving one from another. The same contract test
should tie them together.
