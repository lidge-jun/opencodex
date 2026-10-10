# 000 — Desktop-owned `ocx` command on PATH

**Problem.** OpenCodex Desktop runs its own bundled CLI as the proxy sidecar, but nothing puts that CLI on the user's PATH. An app-only install has no `ocx` command on macOS (DMG drag install) or Windows (WiX MSI). When the user also has an npm, pnpm, bun-link, Homebrew or nvm `ocx`, a terminal runs that package launcher instead, which may be years older than the Desktop runtime or broken outright. On the maintainer Mac on 2026-10-09, Desktop 2.81.0 was serving port 10100 while PATH resolved a dev-checkout bun-link shim and a Homebrew-linked shim (both failing with "the bun dependency is not installed") and an nvm `ocx` 2.7.43.

**Answer.** Desktop installs and maintains its own `ocx` command automatically on every launch, with an off switch and a clean removal path. On macOS and Linux it writes a small fail-closed shim into `~/.opencodex-desktop/bin` and a managed block at the end of the user's zsh, bash and fish startup files, so new shells put that directory first. On Windows it puts the Desktop install directory at the front of the user `Path`. Package launchers that still run (an older shell, an explicit path) hand off to the Desktop CLI when Desktop's record says it is installed. `ocx status` and `ocx doctor` report which `ocx` comes first on PATH.

**Who it changes.** Desktop users get a working `ocx` in new terminals that talks to the Desktop sidecar. Users without Desktop see no change. Users who turn the feature off, or remove it, get their files back without Desktop's block.

Evidence: [001_audit_evidence.md](001_audit_evidence.md) (three independent audits). Architect consultation and dispositions: [002_architecture.md](002_architecture.md).

## Loop spec

| Field | Value |
|---|---|
| Loop archetype | Satisfy-spec, multi-cycle (docs-first roadmap, then one PABCD cycle per work phase). |
| Trigger | Owner request 2026-10-09: "app이 돌 때 path가 절대 npm을 바라보지 않도록 다음 릴리즈 때 패치하고 머지해줘", after lane L1 deferred the PATH installer (L1 unit 040). |
| Goal | In every new supported shell (zsh, bash, fish, PowerShell, cmd) on a stable Desktop install, `ocx` resolves to the Desktop-bundled CLI first; package launchers that still run hand off to it; diagnostics tell the truth when something else wins. |
| Non-goals | No guarantee for shells already open, aliases/functions, absolute npm paths, `zsh -f`, or a later `nvm use` in the same shell. No admin/root writes (`/usr/local/bin`, `/etc/paths.d`, machine `Path`). No AppImage support. No MSI/deb uninstall hooks. No Windows native launcher binary. No editing of the user's own machine during development. No release, deploy or version bump. |
| Verifier | `cargo fmt --check`, `cargo clippy --all-targets -D warnings`, `cargo test` in `desktop/src-tauri` (CI job `desktop shell`, Ubuntu); focused `bun test` files listed in 010/020; `bun run typecheck`; `bun run structure:check`; `bun run privacy:scan`; exact-head hosted CI. Each verifier's target coverage is recorded in its decade doc. Windows registry behavior is covered by Rust unit tests over the pure Path-string transform only; native Windows terminal selection is human/QA evidence, not a CI claim. |
| Stop condition | Both PRs merged to `dev` with criteria c-1..c-7 met, or a NEEDS_HUMAN/BLOCKED/UNSAFE outcome. |
| Memory artifact | This unit (`devlog/_plan/261009_desktop_owned_path_cli/`), the codexclaw goalplan bound to session 01a11e2e, PR descriptions. Unpublished security analysis stays in `.tmp/`. |
| Expected terminal outcomes | DONE: both PRs merged with evidence. NEEDS_HUMAN: owner policy question (e.g. rc edits) or Windows system-PATH conflict judged blocking. BLOCKED: hosted CI cannot run. UNSAFE: review finds an environment-mutation risk that cannot be fixed. |
| Escalation | Reviewer FAIL twice on the same finding, a security finding in the shim provenance (A11), or a merge conflict with lane L1 that changes a shared contract. |
| Resource bounds | None stated by the owner; host limits apply. Local tests stay minimal (owner instruction). Tool scope: repository edits in this worktree, `gh` for PR/CI, admin squash merge to `dev` (owner: "머지 판단 전부 admin으로 진행해"). |

## Contract (A0)

On a stable Desktop install, Desktop configures supported shells at launch so that new sessions select the Desktop-bundled CLI first. The choice to disable or remove survives restarts. The POSIX shim fails closed when the bundled CLI is gone; it never searches for another `ocx`. Conflicts and unobserved shell state are never reported as success. PATH configuration persists after the app quits, the same way Start at Login does. This is configuration, not enforcement: an alias, an absolute path, or a shell that rewrites PATH later can still pick something else, and `ocx doctor` reports that.

## Work-phase map (dependency order)

| Phase | Decade doc | Builds | Independently verifiable by |
|---|---|---|---|
| wp0 | this unit | Audits, architecture, diff-level plan, plan audit | Plan audit PASS |
| wp1 | [010](010_desktop_cli_command.md) + 003 AM-5..AM-13 | Foundation and core: record contract, lock and journal, stable-bundle check, POSIX shim + `path.sh` + rc blocks, Windows user `Path`, launch reconcile, local `cli.html` page, tray entry and dashboard entry (`gui/src/lib/desktop-shell.ts`, sidebar, all GUI locales), `return_to_dashboard` guard widening, shim launch provenance (A11) | `cargo test`/`clippy`/`fmt`, Desktop UI surface test, GUI unit test + `lint:gui` + GUI build, docs, PR screenshot |
| wp2 | [020](020_launcher_handoff_and_diagnostics.md) | Integration: record reader, package-launcher handoff with proof regeneration and exceptions, internal version-probe bypass, PATH diagnostics in `status`/`doctor` | focused `bun test` files, typecheck |
| wp3 | [030](030_docs_review_merge.md) | Hardening and delivery: docs (en/ko + locale consistency), structure docs, independent code and security review, exact-head CI, admin merge, post-merge check | review verdicts, CI run ids, merge SHAs |

wp1 and wp2 publish as a manual two-PR stack (DEV-STACK-01): PR 1 (wp1) targets `dev`; PR 2 (wp2) targets PR 1's branch and is retargeted to `dev` after PR 1 merges. PR 2 consumes PR 1's record schema only through `src/lib/desktop-cli-record.mjs`.

## Coordination with lane L1

Open L1 PRs #6802 (runtime authority), #6809 (command guards, stacked on #6802) and #6807 (launcher PATH Bun fallback) touch `bin/ocx.mjs`, `status.ts`, `doctor.ts`, `structure/runtime.md` and the desktop guide. This unit keeps its logic in new files and adds only thin hooks to those files. The Desktop command record is never used as runtime-ownership or service evidence. `findDesktopCli` from #6807 stays advisory. If L1 lands first, PR 2 rebases onto it; anchors in 020 are written by function name, not line number.

## Plan amendments (main, after 010/020 drafts)

These override the matching text in 010 and 020. Implementation follows the amended form.

- **AM-1 Record stays small; journal bytes move out.** 010 stored the exact before/after bytes of each rc file inline in `pending`, while 020's reader refuses records over 64 KiB. A large `.zshrc` would then make every package-launcher call fail with `record-too-large`. Amended: `pending.changes[]` keeps `kind`, `path`, `mode`, `beforeSha256`, `afterSha256` and `journalFile` (a fixed path under `~/.opencodex-desktop/journal/`, 0600) that holds the bytes. Registry changes keep their raw UTF-16 strings in the journal file as well. `cli.json` is capped at 64 KiB by the writer (refuse to save a larger record) and the reader keeps its 64 KiB bound.
- **AM-2 Failed record reads tell the user how to get out.** 020 turns an invalid, unreadable, too-large or enabled-pending record into a launcher error, so a broken record would block every npm `ocx`. Kept fail-closed, but the error text names both exits: open OpenCodex Desktop to repair the terminal command, or run with `OCX_NO_DESKTOP_HANDOFF=1`. (Corrected in 003: deleting the record is not offered as safe, because the shim and rc blocks would stay behind without an owner.) Covered by the reader-refusal test asserting the message.
- **AM-3 Linux without a tray.** The settings page needs a second entry because a Linux session without a tray host cannot reach the tray item. Add a fixed local link to `cli.html` in `desktop/ui/index.html` (bootstrap page). No dashboard (`gui/`) change.
- **AM-4 Criterion c-1 wording.** Goalplan c-1 says "Linux deb unchanged"; A9 adds the same user shim and rc block on deb while keeping `/usr/bin/ocx`. Read c-1 as "`/usr/bin/ocx` unchanged". The goalplan text is not rewritten; this note is the reconciliation.
