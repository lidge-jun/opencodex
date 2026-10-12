# wp2 — the build telling the truth about its own state

Two defects and one rough edge, all of the same shape: the build produced a state nobody could see
from its output.

## 1. The release profile could not compile the app (landed)

`cargo build --release` stopped at `ctor` with `can't find crate for ctor_proc_macro`. The dev
profile compiled the identical graph. `[profile.release] strip = "symbols"` is applied by cargo to
build scripts and proc macros as well as to the crate under build, and a proc macro is a host dylib
rustc loads by symbol, so stripping it leaves a file rustc cannot read. The error names the macro
and never mentions the profile that removed its symbols.

`[profile.release.build-override] strip = false` in `desktop/src-tauri/Cargo.toml`, with the reason
in a comment because the next reader of that error will otherwise go looking at the dependency.
Verified by `cargo build --release -p ctor` failing before and passing after, and by the full
`tauri build` reaching both bundles afterwards.

## 2. A stale dashboard bundle was invisible (landed)

`gui/dist` was five days old, so the served page predated #5196 and could not contain the usage
companion panel. Nothing failed — the proxy answered and the page loaded, and the feature simply was
not in the bundle, which reads as the feature being broken.

`src/server/gui-freshness.ts` compares the newest mtime under `gui/src` with the served bundle and
`ocx status` prints the rebuild command beside the dashboard URL. It reports and never rebuilds: a
proxy compiling a frontend at startup trades silent staleness for a slow, surprising start.

Unknown is not stale, because a packaged install ships no `gui/src` and a missing bundle is a
separate condition. `node_modules` is skipped so a dependency install cannot make sources look
newer than they are. Four regressions in `tests/server/server-gui-bundle-freshness.test.ts` hold those
cases, and the live check was confirmed by touching a source file and watching the warning appear
and then disappear after a rebuild.

## 3. A local build ends on a failure after succeeding (this phase)

`createUpdaterArtifacts` is true and `plugins.updater.pubkey` is set in `tauri.conf.json`, so Tauri
always builds the updater archive and then refuses to finish without `TAURI_SIGNING_PRIVATE_KEY`:

```
Finished 2 bundles at: .../OpenCodex.app, .../OpenCodex_2.61.0_aarch64.dmg
A public key has been found, but no private key. Make sure to set TAURI_SIGNING_PRIVATE_KEY
Error failed to build app
```

Both bundles exist at that point. The command still exits non-zero, so a developer building locally
sees a failure for a signing step they were never meant to perform, and a script wrapping the build
cannot distinguish this from a real failure.

The release path must keep failing here: an unsigned updater artifact shipped to users is worse
than a failed release. So the fix is not to relax the check but to give the local build a path that
does not ask for the artifact at all — an explicit script that builds the app and dmg without
updater artifacts, documented beside the existing release instructions.

### Acceptance

A local build command produces `OpenCodex.app` and the dmg and exits zero without a signing key.
The release instructions still describe the signed path, and nothing weakens the requirement that a
published updater artifact is signed.
