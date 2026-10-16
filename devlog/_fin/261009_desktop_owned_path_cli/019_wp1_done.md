# 019 — wp1 outcome

wp1 is implemented on `codex/desktop-owned-path-cli` (commits ab5a658b32 → 9a1da663a0, based on `origin/dev` 71c4ae3c8e). Workers: W1 Rust core (`01a11f84-f4e9`), W2 wiring and local page (`01a11f84-f5a1`), W3 dashboard and docs (`01a11f84-f66b`), real-shell test (`01a11fa3-3e5b`), all gpt-6.1-sol; main integrated and fixed the Windows findings.

## What exists now

- `desktop/src-tauri/src/cli_command.rs`, `cli_command_record.rs`, `cli_command_posix.rs`, `cli_command_windows.rs`: record and external journal (AM-1/AM-6), shared validation and limits (AM-5), owned-vs-desired rc reconciliation (AM-7), first record carries its bundle (AM-10), shim with launch provenance (A11), `path.sh`, zsh/bash/fish blocks, Windows user `Path` transforms and raw registry IO.
- Wiring: four commands behind `require_cli_page`; `return_to_dashboard` behind `require_local_settings_page` (update and terminal-command pages only; the update commands keep `require_update_page`); reconcile scheduled after `adopt_launch_origin_argument`; tray item; `desktop/ui/cli.html` + `cli.js`.
- Dashboard entry (AM-11): `desktopCliPageUrl`/`openDesktopCliPage`, desktop-only "Terminal command" entry, strings in all 11 GUI locales.
- Shared record fixtures `tests/fixtures/desktop-cli-record/` (10 files), source-contract test `tests/clients/desktop-cli-command-surface.test.ts`, docs (`structure/desktop-shell.md` 597/600, desktop guide en/ko extending the existing CLI section).

## Evidence

| Check | Result | Observes |
|---|---|---|
| `cargo fmt --check`, `cargo clippy --all-targets -D warnings`, `cargo test` (macOS, Rust 1.95) | 0 / 0 / 228 passed, 2 ignored | All new modules, guards and tests compiled for macOS |
| Same on Windows 11 host `mini` (Rust 1.98), `cargo clippy --all-targets -D warnings` + `cargo test cli_command` | 0 / 14 passed | Windows-only registry IO, FFI and Path transforms compile and pass; it first found two lints and a JSON escaping bug in a test, fixed in d669955 and 116985a |
| `cargo test real_shell -- --ignored` (macOS) | 1 passed | Real `zsh -i` and `bash -l -i` on a temporary HOME with an npm-style `ocx` prepended in `.zshrc`/`.bashrc`: the Desktop shim wins; an npm prepend appended after the block loses again after reconcile moves the block back to the end; Remove restores the npm `ocx` and keeps the user's lines (c-1/c-2 on macOS) |
| `bun test` surface + update/startup surface + layout guards | 59 pass, 0 fail | Command registration, guards, page invocation contract, layout registration |
| GUI: `lint`, `lint:i18n`, `tsc -b`, `bun test tests`, `build` | 0, 0, 0, 3018 pass, 0 | Dashboard entry, helpers, locales |
| `bun run typecheck`, `structure:check`, `privacy:scan`, file-size ratchet | all pass | Repository gates |
| Rendered `cli.html` with stubbed `invoke` (headless Chrome via agbrowse, isolated profile) | Initial render correct; Repair → `cli_install` and partial state with issue list; Remove → `cli_remove` and "off"; toggle → `cli_set_enabled`; Back → `return_to_dashboard` (never `show_dashboard`) | Page behavior; not a packaged Desktop round trip |

## Open for wp3 and release QA

- A11: implemented; compiled-CLI verification (shim run + control run, AM-13) and the independent security review are pending in wp3.
- Not observed by this phase: packaged OpenCodex.app click-through (dashboard → Terminal command → Back), fish, Linux deb, Windows native terminal selection after a real registry write. Release QA items for PR 1.
- Planning line budgets for the new Rust modules were exceeded (`cli_command_record.rs` 1197, `cli_command_posix.rs` ~1000, `cli_command_windows.rs` 476, `cli_command.rs` 439). Rust is not under the repository ratchet; the budgets were planning caps. Accepted as an amendment; reviewers may ask for a split.

