# 011 — wp1 execution plan (re-verified)

wp1 implements 010 as amended by 003 (AM-5..AM-13; AM-3 withdrawn by AM-11). This document is the cycle's executable plan: what was re-verified against the current base, the consolidated worklist, the worker split for B, and the C checks. Where 010 and this document differ, this document and 003 win.

## Stale check against the new base

Base: `origin/dev` 71c4ae3c8e (after #6802, #6805 and today's other merges); branch `codex/desktop-owned-path-cli` rebased, roadmap commit 8a1ea2c070.

| 010 anchor | Current state | Action |
|---|---|---|
| `startup.rs` `register` (1449), `adopt_launch_origin_argument(app)` (1473), `finish` (1589), `keeps_update_page` (1688) | Unchanged | Apply as written |
| `lib.rs` update commands guarded by `require_update_page` (221–241), `return_to_dashboard` (249–250), `generate_handler!` (287) | Unchanged | AM-12 widens only line 250 |
| `window.rs` `is_app_origin` (105), `require_update_page` (113) | Unchanged | Add `require_cli_page` and `require_local_settings_page` |
| `tray.rs` `install` (72), `check-updates` item (91) and handler (219) | Unchanged | Add the terminal-command item next to it |
| `structure/desktop-shell.md` | 568 lines (was 546; #6802 added 22) | Budget +26 → 594 ≤ 600; keep the addition at or under 30 lines |
| desktop guide en/ko | #6802 added "Using the ocx CLI with the desktop app" | Extend that section with the terminal-command paragraphs instead of a new competing section |
| `scripts/test-layout/layout.json` 1981 / `tests/fixtures/test-layout-expected.json` 1181 | Unchanged in shape | Register the new test in both |
| Toolchain | cargo/rustc 1.95.0 present locally | `cargo fmt`/`clippy`/`test` run locally on macOS |

## Consolidated wp1 worklist

1. Rust record module (`cli_command_record.rs`): schema per 010 with AM-1/AM-6 external journal, AM-5 validation and limits (`rcFiles ≤ 16`, `changes ≤ 32`, record ≤ 64 KiB on write and read), AM-7 ownership list validation, AM-10 `Record::fresh(bundle)`, lock.
2. Rust POSIX module (`cli_command_posix.rs`): stable bundle (AM-10 order), shim with A11 proof generation, `path.sh`, zsh/bash/fish blocks, rc edit/reposition/removal with AM-7 desired-vs-owned reconciliation.
3. Rust Windows module (`cli_command_windows.rs`): pure Path transforms + raw HKCU IO + `WM_SETTINGCHANGE` (FFI as in 010, no new crate).
4. Rust orchestration (`cli_command.rs`): reconcile on launch (blocking worker after `adopt_launch_origin_argument`), `status`, `set_enabled`, `install`, `remove` (disabled intent stored first), AM-6 recovery state table.
5. Wiring: `lib.rs` four commands + `return_to_dashboard` guard (AM-12); `window.rs` guards; `startup.rs` hook + keep `cli.html` on Ready like the update page; `tray.rs` item.
6. Local page: `desktop/ui/cli.html` + `cli.js` (Back → `return_to_dashboard`).
7. Dashboard entry (AM-11): `gui/src/lib/desktop-shell.ts` `desktopCliPageUrl`/`openDesktopCliPage`, desktop-only entry beside the Desktop update row, strings in every GUI locale, GUI unit test.
8. Shared fixtures `tests/fixtures/desktop-cli-record/*.json` (AM-5), used by Rust tests via `include_str!` now and by wp2's TS reader later.
9. Source-contract test `tests/clients/desktop-cli-command-surface.test.ts` + both layout registrations.
10. Docs: `structure/desktop-shell.md` (≤ 30 lines added), desktop guide en/ko extension of the existing CLI section, locale contradiction sweep.

## B worker split (disjoint files, one worktree, no branch operations)

| Worker | Files | Depends on |
|---|---|---|
| W1 Rust core | items 1–4, 8 | 010 interfaces |
| W2 Wiring and local page | items 5, 6, 9 | W1's public function names as fixed in 010 (`reconcile_on_launch`, `status`, `set_enabled`, `install`, `remove`, `State`) |
| W3 Dashboard and docs | items 7, 10 | none |

Main integrates, runs the C checks and fixes compile errors across the seams.

## C checks for wp1

| Command | Reads the change? |
|---|---|
| `cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check` | Yes, once the modules are declared in `lib.rs` |
| `cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings` | Yes (compiles all targets including tests) |
| `cargo test --manifest-path desktop/src-tauri/Cargo.toml cli_command` and `... window` | Yes, the new in-module tests and the URL guards |
| `bun test tests/clients/desktop-cli-command-surface.test.ts tests/clients/desktop-update-surface.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts` | Yes; reads Rust/UI source as data and both layout files |
| `cd gui && bun test <desktop-shell test> && bun run lint && bun x tsc -b` | Yes for the dashboard entry |
| `bun run structure:check`, `bun run privacy:scan`, `bun scripts/file-size-ratchet.ts` | Yes after the files are staged |
| Real-shell check (030, c-1/c-2) with a temporary `HOME` on macOS zsh and bash | Yes; runs the Rust reconcile through a test binary and then real shells |
| A11 compiled check (AM-13) | Moved to wp3 C, where the compiled host CLI is built once for both PRs |

Everything else (Windows native, fish, Linux deb, packaged app click-through) is release QA, named in PR 1.


## Reflection (same architect, 01a11f35): ALIGNED

Folded into this plan:

- W2 also depends on W1's `show_page` (the tray handler calls it).
- The surface test's dashboard-gating assertion depends on W3's output, so main runs it after integrating W1–W3.
- C adds a rendered check of `cli.html` with a stubbed `invoke` (static render in a headless browser, separate from the packaged click-through QA), `cd gui && bun run build` (Vite build, not only `tsc -b`), the GUI test file `gui/tests/desktop-shell.test.ts`, and the PR screenshot of the dashboard entry.
- At wp1 close, A11 is recorded as "implemented, verification pending in wp3" (shim run + control run + independent security review; AM-9 merge decision if the compiled check cannot run).


## Audit (independent, 01a11f6b): NEAR-PASS

Folded: C adds `cd gui && bun run lint:i18n` and `cd gui && bun test tests` (callback wiring and conditional render); the rendered `cli.html` check reads its screenshot and exercises toggle, remove and Back against the stubbed `invoke`, recorded separately from any real Desktop round trip; Windows-only code (registry IO, FFI) is neither compiled nor run on macOS `clippy --all-targets` and is named as residual (compile coverage only if a Windows CI job builds the desktop crate; native behavior is release QA).

