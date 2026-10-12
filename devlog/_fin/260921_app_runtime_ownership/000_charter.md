# One runtime, one owner

## What was asked

Three things, in the user's words:

1. Launching the app should stop the npm-installed runtime safely and bring up the app's own
   runtime instead — on every platform.
2. Whatever permissions the app needs should be requested up front at first launch, the way
   Karabiner does, rather than failing later.
3. Cmd+Q should leave the app in the menu bar and keep it running, not end the process.

These are not three separate features. They are three faces of one question the codebase has never
answered: **who owns the running proxy, and how does ownership change hands.**

## Why the current code cannot answer it

The desktop shell decides ownership with a single boolean set once at startup.
`desktop/src-tauri/src/sidecar.rs` waits up to two seconds for anything to answer `/healthz` on the
discovered port; if something does, it returns `None` and the app is a guest, and if nothing does it
spawns the bundled sidecar and the app is the owner. `AppState::spawned_by_us` carries that answer
for the rest of the process lifetime.

Every one of the user's three asks breaks on that boolean.

- **Takeover has no representation at all.** There is no path from guest to owner. An existing npm
  runtime is joined, never replaced, and nothing asks the user which they want.
- **Quit is `CommandChild.kill()`**, which is SIGKILL on Unix (`desktop/src-tauri/src/lib.rs`). The
  CLI's own stop path restores client configuration, drains in-flight requests and clears state
  files; the app's quit path does not wait for any of it. Cmd+Q reaching that code is not a
  cosmetic problem — it is the destructive path firing on a keystroke the user expects to mean
  "hide".
- **Permissions are never requested.** `first_run.rs` enables Start at Login once per install and
  swallows every failure, which is the opposite of asking up front.

## The gap this unit has to close

Core already knows how to answer the ownership question. `src/server/proxy-liveness.ts` resolves a
live proxy from the pid record plus the runtime-port record, requires the `/healthz` body to
identify as opencodex, and carries back the version and the listener role. `src/service/state.ts`
records which launcher installed the service. The Rust side reimplemented a weaker version of the
same question — `discovery.rs` reads `runtime-port.json`, falls back to 10100 and then starts with
`--port 10100`, so a user on a custom `config.port` gets a different port than the one they
configured.

So the work is mostly connection, not invention: give the shell the identity, readiness, graceful
stop and restart meaning that already exist in core, and add the one thing core does not have —
an explicit handover between two installations.

## Status

Interview open. The charter is recorded; the diff-level plan is not written yet because the
takeover semantics, the platform scope and the permission surface are still open questions with
the user. Evidence gathered so far is in `010_coexistence_findings.md` and
`020_windows_linux_findings.md`.

