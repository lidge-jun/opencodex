# Desktop app stabilization — local build and conflict handling

Status: OPEN. Opened against `dev` after the desktop stack landed as #5318 and the Claude Desktop
chain as #5319. This unit records what the first real local build found and what the app does when
it meets something already running.

## The release profile could not build the app at all

`cargo build --release` stopped at `ctor`, a transitive dependency of `tauri-utils`:

```
error[E0463]: can't find crate for `ctor_proc_macro`
   --> ctor-0.8.0/src/lib.rs:244:9
```

The same graph compiles in the dev profile. The difference is `[profile.release] strip = "symbols"`,
which cargo applies to build scripts and proc macros as well as to the crate being built. A proc
macro is a host dylib that rustc loads by symbol, so stripping it leaves a file rustc cannot read,
and the error names the macro rather than the profile that removed its symbols.

`[profile.release.build-override] strip = false` restores it. The fix is one line plus the reason,
because the next person to read `can't find crate` will otherwise go looking at the dependency.

This did not surface earlier because nothing had built the desktop app in release outside CI, and
CI's toolchain tolerated the stripped dylib. It is reproducible here on rustc 1.95.0.

## Two installations at once

The widget snapshot has two writers that target the same path:

- `app/Sources/MenuBarCore/WidgetSnapshot.swift` builds it from
  `~/Library/Containers/com.opencodex.desktop.widget/Data/Library/Application Support/OpenCodex/snapshot.json`
- `desktop/src-tauri/src/widget.rs:246` writes the same file from Rust

Each deduplicates with its own in-process `lastWritten`, so two live writers do not settle: each
sees the other's file as changed, rewrites it, and calls `reloadTimelines`. The current build no
longer ships a standalone menu bar executable — `app/Package.swift` declares only the widget appex
and its test harness — so this is reachable only for a user who still has an earlier standalone
build installed. `tauri_plugin_single_instance` guards a second copy of the same bundle and cannot
see a different one.

## Proxy ownership

`spawned_by_us` in `desktop/src-tauri/src/lib.rs` records whether the app started the proxy, and
`tray.rs` enables **Stop proxy** from it. It is consumed with `swap(false)`, so the behaviour after
a stop-and-restart cycle needs checking rather than assuming.

## Execution note

This unit builds and installs locally at the maintainer's explicit request, which is a deliberate
exception to the no-local-build rule the surrounding batch worked under. Test suites are still not
run here.
