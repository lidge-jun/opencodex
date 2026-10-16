# 6972 — Tray Start at Login uses the Startup safety judgment

Issue: lidge-jun/opencodex#6972. Related: #6980 (Startup page label only), #6963.
Branch: `codex/6972-tray-start-at-login-launchd-261012`, target `dev`.

## Problem

On macOS the tray's **Start at Login** `CheckMenuItem` is built from
`app.autolaunch().is_enabled()` (tauri-plugin-autostart 2.5.0 → auto-launch 0.5.0), which
is `Path::exists(~/Library/LaunchAgents/OpenCodex.plist)`. Startup safety
(`src/service/desktop-startup.ts` `macLoginRegistration`) credits the registration only when:

1. the plist has the auto-launch shape (`Label` OpenCodex, `RunAtLoad` true,
   `ProgramArguments = [<…>/Contents/MacOS/opencodex-desktop, --autostart]`, `Program`
   absent or equal, `Disabled` absent or boolean), app and sibling `ocx` resolve and are
   executable;
2. `launchctl print-disabled gui/<uid>` is well formed and either does not mention
   `"OpenCodex"` (then plist `Disabled !== true`) or mentions it exactly once as
   `enabled`/`false`;
3. `launchctl print gui/<uid>/OpenCodex` either names this app as `program` and the
   registration plist as `path` (`loaded`), or fails with the exact service-not-found result
   (status 113, exact stderr) and a full re-capture is unchanged (`registered-not-loaded`);
4. the registered app equals the app being judged (unowned supervision path:
   `login.app === app`).

So a launchd-disabled job, another app copy, or a loaded job from an old copy show a checked
tray item while Startup reports Start at Login unverified. Clicking writes the plist again,
which neither clears a launchd override nor respects another copy's registration.

## Decision

Port the judgment to Rust (`desktop/src-tauri/src/login_registration.rs`) as a pure
classifier over an injected probe, and prove parity with one shared fixture file read by both
a Rust unit test and a bun test that drives the TypeScript judgment. The tray checks the item
only for the verified state. The classifier subdivides "not verified" so the tray can explain
and choose a safe click action:

| State | TS `loginEnabled` | Checked | Label | Clickable | Click action (after a fresh re-probe that still returns the same state) |
|---|---|---|---|---|---|
| `On` (loaded or registered-not-loaded, this copy) | true | yes | Start at Login | yes | plugin `disable()` (unchanged) |
| `Off` (plist absent) | false | no | Start at Login | yes | `login_autostart::enable` (unchanged) |
| `DisabledBySystem` (this copy; print-disabled override disabled/true) | false | no | Start at Login (off in System Settings) | yes | open `x-apple.systempreferences:com.apple.LoginItems-Settings.extension`; never rewrites the plist |
| `OtherCopy` (registered app or loaded program resolves to another existing copy) | false | no | Start at Login (another OpenCodex copy) | no | none |
| `MissingCopy` (registered app path does not exist) | false | no | Start at Login (registered app is missing) | yes | `login_autostart::enable` for this copy |
| `Unknown` (probe failure, timeout, malformed output, shape mismatch, plist Disabled=true without override, path mismatch, changed during probe, not yet probed) | false | no | Start at Login (status unknown) | no | none |

Invariant: `checked ⇔ state == On ⇔ TS loginEnabled for this app`. Nothing but `On` is
checked; an unverified result can never become checked.

Why the Rust port instead of asking the running proxy: the tray must work when no proxy is
attached or when the attached proxy is an older runtime, and the proxy's Startup diagnostics
judge the supervising app, which is not necessarily this copy. The shared fixture is the
drift guard.

## Diff plan

### `desktop/src-tauri/src/login_registration.rs` (new)

- `pub enum LoginState { On, Off, DisabledBySystem, OtherCopy, MissingCopy, Unknown }` with
  `checked()`, `label()`, `clickable()`, `click_action() -> ClickAction`.
- `pub trait Probe { identity(&Path) -> io::Result<String>; realpath(&Path) -> io::Result<PathBuf>;
  executable(&Path) -> io::Result<()>; run(&str, &[&str]) -> Result<String, RunError> }`,
  `RunError::{Exit { status, stderr }, Failed}` (timeout, signal, spawn failure, oversize →
  `Failed`).
- `pub fn classify(probe, home, uid, current_app) -> LoginState` mirroring
  `macLoginRegistration` step for step: capture (realpath + identity of plist and target,
  plutil JSON, shape, app/ocx realpath + X_OK + identity, print-disabled parse, re-check of
  every path/identity), then loaded/not-loaded branch with full re-capture comparison.
  Parsers mirror the TS regexes by hand (no new crate).
- `#[cfg(target_os = "macos")] pub struct SystemProbe`: `std::fs` realpath and
  `MetadataExt` identity (dev, ino, size, mode, mtime ns, ctime ns), and
  `std::process::Command` with a 750 ms deadline (try_wait poll, kill on timeout), 128 KiB
  cap and trimmed UTF-8 stdout, matching TS `run`. `getuid` and `access(X_OK)` are declared
  through `extern "C"` (precedent: `geteuid` in `cli_command_record.rs`), so executability
  matches TS `accessSync(X_OK)` with no new dependency.
- `#[cfg(test)]` parity test reading `../../../tests/fixtures/desktop-login-registration-cases.json`
  through `include_str!` with a fake probe; plus the invariant `checked == startupLoginEnabled`.

### `desktop/src-tauri/src/tray.rs`

- macOS: build the item unchecked with the `Unknown` label and disabled, store it in
  `TrayMenu`, then spawn the first probe. Keep the plugin path on Linux/Windows unchanged.
- `"start-at-login"` on macOS: `spawn_blocking` → take the probe lock, re-probe; if the
  fresh state differs from the state the menu displayed, apply it and stop; otherwise run the
  state's click action, re-probe and apply. Always re-apply so muda's automatic check toggle
  never survives.
- Refresh (try-lock, skip when busy): at install, `TrayIconEvent::Enter` (throttled to 2 s),
  and the existing 60 s loop (before the "no proxy" `continue`).
- Setters run only on background threads and never while holding the menu mutex
  (existing `menu_handles` rule).

### `desktop/src-tauri/src/lib.rs`

- `#[cfg(any(target_os = "macos", test))] mod login_registration;`

### `src/service/desktop-startup.ts`

- Extract the existing unowned-path lambda into
  `export function macLoginFactsFor(app, deps)` (no behavior change) so the parity test
  judges exactly what Startup safety uses for "this app".

### Tests

- `tests/fixtures/desktop-login-registration-cases.json` (shared cases, placeholders
  `{APP}`, `{OTHER_APP}`, `{MISSING_APP}`, `{PLIST}`, `{OTHER_PLIST}`, `{UID}`).
  Cases: loaded current; registered-not-loaded (both stderr forms); override enabled /
  false; override disabled / true; plist absent; plist Disabled=true without override;
  plist Disabled=true with enabled override; other copy registered; loaded job from other
  copy; loaded path mismatch; registered app missing; ocx missing; plutil failure; shape
  mismatches (no --autostart, wrong Label, wrong suffix); print-disabled failure, malformed,
  duplicate mentions; print failure non-113, timeout/signal, 113 with other stderr;
  registration changed during the not-loaded re-capture.
- `tests/service/service-desktop-login-registration.test.ts`: materializes the fixture in a
  temp home, drives `macLoginFactsFor`, asserts `loginEnabled`/`loginRegistration` and the
  tray invariant. Registered in `scripts/test-layout/layout.json` and
  `tests/fixtures/test-layout-expected.json`.

### Docs

- `structure/desktop-shell.md`: tray Start at Login judgment, states, click rules, parity
  fixture.
- `docs-site/src/content/docs/guides/macos-menu-bar.md` and `desktop-app.md` (English):
  the checkbox shows only a verified registration; reason labels.

## Out of scope

Linux/Windows tray, `first_run.rs` (its once-per-install migration still uses the plugin),
`gui/`, `app/`, TS judgment semantics, any real launchd/LaunchAgents state.

## Verification

- `cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check`
- `cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml`
- `bun test tests/service/service-desktop-login-registration.test.ts tests/service/service-desktop-startup.test.ts tests/service/service-desktop-startup-health.test.ts`
- `bun run typecheck`, `bun run structure:check`, `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts`, `bun run privacy:scan`
- No real launchd: tests use fakes and temp homes only.


## Audit round 1 (GPT-6.1-Sol high): FAIL → folded

1. **MissingCopy takeover** — accepted. `MissingCopy` is non-clickable like `OtherCopy`; a
   missing path may be an installation being replaced or on an unmounted volume. Table:
   MissingCopy → Clickable no, action none.
2. **first_run migration rewrites another copy** — accepted. On macOS
   `adopt_launch_origin_argument` only rewrites when the plist's `ProgramArguments[0]`
   resolves to this running copy (legacy entries without `--autostart` included, via
   `login_registration::registered_to`). Foreign, missing or unreadable registrations are left
   untouched and the marker is not written, so a later launch can still migrate this copy's own
   entry. Covered by Rust unit cases (this copy / other copy / missing / legacy shape / plutil
   failure / absent).
3. **auto-toggle before probe** — accepted. The menu callback (main thread; Tauri runs setters
   inline there, `tauri-runtime-wry` `send_user_message`) immediately restores the last
   applied presentation and disables the item, then spawns the blocking job. It never waits on
   the probe lock. Jobs and refreshes are serialized by one probe mutex; refreshes use
   `try_lock`. The residual is AppKit's own toggle between the click and the callback.
4. **X_OK** — already folded: `access(path, X_OK)` via `extern "C"`.
5. **parser boundaries** — accepted: fixture adds delimiter/newline/EOF, invalid suffix
   (`enabledx`), duplicate mentions, malformed envelope, non-boolean `Disabled`, `Program`
   equal/different, symlinked plist, 113 with signal-style failure, wrong uid in stderr,
   changed registration during re-capture.
6. **Linux dead code** — accepted: portable tests exercise `label`/`clickable`/
   `click_action`; macOS-only constants and helpers sit behind `cfg(target_os = "macos")`;
   CI clippy runs on Linux, local run on macOS, both `--all-targets -D warnings`.
7. **label overclaims** — accepted: "Start at Login (disabled by macOS)"; click opens Login
   Items settings, opener failure is logged once, and nothing is credited until a fresh probe.
8. **translations** — accepted: update `ko/guides/desktop-app.md` and any locale that
   describes the checkbox as file existence; update `structure/desktop-shell.md` first-run
   paragraph.


## Audit round 2 (GPT-6.1-Sol high): FAIL → folded

1. **first-run guard and `Program`** — accepted. `login_registration::migration` returns
   `Rewrite` only for `Label` OpenCodex, `RunAtLoad` true, `ProgramArguments` =
   `[<…>/Contents/MacOS/opencodex-desktop]` or `[…, --autostart]`, `Program` absent or equal to
   argument zero, and argument zero resolving to this running copy. Everything else is `Leave`.
2. **first-run re-enables a self-disabled plist** — accepted. `Disabled` must be absent or
   `false`; a `true` or non-boolean value is `Leave`. A launchd override is untouched by a
   plist rewrite, so it needs no special case. `Leave` does not write the origin marker;
   `Absent` does (unchanged from the current `Ok(false)` branch).
3. **ECMAScript line terminators** — accepted. `line_value` splits on `\n`, `\r`, U+2028 and
   U+2029. Shared fixture adds CR / U+2028 / U+2029 terminated `launchctl print` output, a
   program value cut at U+2028, a program value that starts after a terminator, and a path value
   cut at CR (58 cases).
4. Inline main-thread setters confirmed (`tauri-runtime-wry` 2.11.4).

Final state table (supersedes the one above):

| State | Checked | Label | Clickable | Action |
|---|---|---|---|---|
| On | yes | Start at Login | yes | disable |
| Off | no | Start at Login | yes | enable for this copy |
| DisabledBySystem | no | Start at Login (disabled by macOS) | yes | open Login Items settings |
| OtherCopy | no | Start at Login (another OpenCodex copy) | no | — |
| MissingCopy | no | Start at Login (registered app is missing) | no | — |
| Unknown | no | Start at Login (status unknown) | no | — |


## Audit round 3 (GPT-6.1-Sol high): FAIL → 4 folded, 1 rebutted

1. **migration drops keys** — folded. `Rewrite` requires exactly the three keys auto-launch
   writes (`Label`, `ProgramArguments`, `RunAtLoad`); `Program`, `Disabled`, `KeepAlive`
   or any other key is `Leave`.
2. **cross-process check-then-act** — rebutted as residual. Every mutation re-probes
   immediately before acting and the window is the few milliseconds between that probe and the
   plugin's file write; the only actor that can interleave is another OpenCodex copy of the
   same user acting in that window. The `Off` → enable write is the existing plugin path.
   Cross-process locking or a custom plist writer is disproportionate to #6972 and would replace
   plugin-owned code; recorded as a known limit in the PR.
3. **lossy UTF-8** — folded: `String::from_utf8_lossy` like Node's `encoding: "utf8"`.
4. **reader joins** — folded: readers send over channels and are collected with
   `recv_timeout` inside the same 750 ms deadline; a blocked reader is abandoned.
5. **presentation interleaving** — folded: every presentation is applied in one
   main-thread closure. A click increments a pending counter and restores/disables on the main
   thread; refresh results are dropped while a click is pending; the click job's own result
   decrements the counter and applies.

## Code review round 1 (GPT-6.1-Sol high, commit 4c5fb7734d): FAIL → folded

1. **migration accepted a plist replaced during its own read** — folded: `migration` now
   captures the plist identity, its resolved target and target identity before `plutil`, and
   re-reads them plus the registered executable's resolution afterwards; any change is
   `Leave`. Regression: `migration_rewrites_only_this_copys_own_enabled_entry` replacement
   case. The reviewer accepted the cross-process rebuttal for the window after a stable final
   probe.
2. **structure doc said two actionable states** — folded: three (verified disables, absent
   enables, launchd-disabled opens Login Items settings).
