# 021 — wp2 execution plan (re-verified)

wp2 implements 020 as amended by 000 (AM-1, AM-2) and 003 (AM-2 corrected, AM-5, AM-8). It runs on branch `codex/desktop-cli-handoff`, stacked on PR 1 (#6816, `codex/desktop-owned-path-cli` at bcbd0363be). This document and 003 win over 020 where they differ.

## Stale check

| 020 anchor | Current state on `origin/dev` 71c4ae3c8e + PR 1 | Action |
|---|---|---|
| `bin/ocx.mjs` update-help, `codexCliUpdateInspection`, mise/npm update branches, `resolveBun`, launch proof creation | Unchanged (1120 lines). #6807 (head 178f19a6f8) and #6809 (head f22a8b1ba5) are open and rebased on `dev`; both edit this file | Insert the handoff at the semantic point (after the inspection block, before the mise/npm update branch); rebase over #6807/#6809 when they land, anchoring on `const codexCliUpdateInspection` and the following mise `if` |
| `src/cli/status.ts` | #6802 merged (+70 lines: `selectStatusStartupHealth` returns `{ startup, startupSource }`, live supervision) | Add `cliCommand` as a separate additive field computed at `collectStatus` entry; do not touch `startupSource`/`serviceSummary` |
| `src/cli/doctor.ts` | #6802 changed restart-safety source and advice | New "ocx command selection" section after Paths, before response-state sections |
| `structure/runtime.md` | 600 lines (cap); #6802 changed 1 line | Edit the existing entrypoint row with zero line growth |
| `structure/ops/service-and-sidecars.md` | 541 → 541 (#6802 changed 4 lines) | +2 lines as planned |
| `src/service/managing-cli.ts`, `src/cli/launcher-context.ts` | Unchanged | Apply as planned |
| Record schema (wp1 actual) | Rust `Record`/`Bundle` use `camelCase` with `deny_unknown_fields`; fixtures in `tests/fixtures/desktop-cli-record/` (10 files, including `first-pending.json`) | TS reader consumes only `version`, `enabled`, `bundle.platform`, `bundle.kind`, `bundle.cliExecutable`, `pending`; tolerates other fields (the reader is not the writer) |

## Amendments applied in wp2

- **AM-5:** the reader validates `bundle.kind` against the platform pair (`darwin`/`macos-app`, `win32`/`windows-install`, `linux`/`linux-deb`), refuses `.`/`..` segments, NUL, newline and paths over 4096 characters, and is tested against every file in `tests/fixtures/desktop-cli-record/` with the same expectations as the Rust test. `enabled:false` wins over `pending` (no target); enabled + pending is `record-pending`. Diagnostics report `cleanup-pending` for a disabled record with a pending journal.
- **AM-1:** reader bound stays 64 KiB, matching the writer cap.
- **AM-2 (corrected):** the launcher error for `record-invalid`, `record-too-large`, `record-unreadable` and `record-pending` reads: "opencodex: OpenCodex Desktop's terminal-command record at <path> could not be used (<issue>). Open OpenCodex Desktop to repair the terminal command, or run with OCX_NO_DESKTOP_HANDOFF=1." No advice to delete the record.
- **AM-8:** after `spawn` fails with ENOENT, `lstat` the target; only a second ENOENT resumes the package path, otherwise print a fixed error and exit 127. Test: a target script whose interpreter is missing.

## B worker split

| Worker | Files |
|---|---|
| W4 handoff | NEW `src/lib/desktop-cli-record.mjs` + `.d.mts`, NEW `src/lib/desktop-cli-handoff.mjs` + `.d.mts`, MODIFY `bin/ocx.mjs` (hook + proof factory reuse), MODIFY `src/service/managing-cli.ts` (`OCX_NO_DESKTOP_HANDOFF=1` on internal probes), NEW `tests/cli/ocx-launcher-desktop-handoff.test.ts` |
| W5 diagnostics and docs | NEW `src/cli/cli-path-diagnostics.ts`, MODIFY `src/cli/status.ts`, `src/cli/doctor.ts`, NEW `tests/cli/cli-path-diagnostics.test.ts`, MODIFY `structure/runtime.md` (zero growth), `structure/cli-management.md`, `structure/ops/service-and-sidecars.md`, `docs-site/src/content/docs/getting-started/installation.md`, `docs-site/src/content/docs/reference/cli.md` |
| main | registrations of both new tests in `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`; integration |

W5 imports the record reader from W4's `src/lib/desktop-cli-record.mjs` using the export names in 020 (`readDesktopCliRecord`, `desktopCliRecordPath`, `DESKTOP_CLI_RECORD_MAX_BYTES`, type `DesktopCliRecordRead`).

## C checks

| Command | Reads the change? |
|---|---|
| `bun test tests/cli/ocx-launcher-desktop-handoff.test.ts tests/cli/cli-path-diagnostics.test.ts` | Yes, both new files and their imports |
| `bun test tests/cli/ocx-launcher-runtime.test.ts tests/cli/ocx-launcher-source.test.ts tests/service/managing-cli.test.ts tests/cli/cli-status-json.test.ts tests/codex-integration/doctor.test.ts` | Yes, existing launcher/probe/status/doctor contracts around the hooks |
| `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts` | Yes, registrations |
| `node --check bin/ocx.mjs`, `bun run typecheck`, `structure:check`, `privacy:scan`, file-size ratchet | Yes after staging |
| Manual: the dev-checkout `bin/ocx.mjs` run with an isolated `HOME` holding a valid record pointing at a fake executable prints the fake's output; with `OCX_NO_DESKTOP_HANDOFF=1` it does not | Yes, real launcher process |

The A11 compiled check (AM-13) runs in wp3 against PR 1's shim, together with the security review of both PRs.


## Reflection (same architect, 01a11f35): ALIGNED

Folded:

- **Reader result type, fixed before B.** `DesktopCliRecordRead` is `{ state: "missing", path } | { state: "disabled", path, cleanupPending: boolean } | { state: "ready", path, record: { platform, kind, cliExecutable } } | { state: "invalid" | "unreadable", path, issue }`. W4 writes it in `.d.mts`; W5 consumes `cleanupPending` for the `cleanup-pending` diagnostic.
- **Fixture expectations map validity to consumption state**, not pass/fail: `valid-*` on its own host → `ready` (other hosts → `invalid`/`record-invalid`); `disabled-tombstone` → `disabled`, `cleanupPending:false`; `disabled-with-pending` → `disabled`, `cleanupPending:true`; `pending-enabled` and `first-pending` → `invalid`/`record-pending` (valid for Rust recovery, refused for handoff); `appimage-kind`, `relative-target`, `dotdot-target` → `invalid`/`record-invalid`.
- **Path rules match Rust exactly:** length counted in Unicode code points (`[...s].length`), Windows absolute means drive-rooted (`C:\\` or `C:/`) or UNC (`\\\\server\\share`) only; root-relative `\\ocx.exe` and drive-relative `C:ocx.exe` are refused. Extra boundary cases in the TS test: 4096 vs 4097 code points with an astral character, root-relative, drive-relative, UNC.
- **Manual smoke checks both sides:** with the record, `ocx --version` prints the fake target's marker; with `OCX_NO_DESKTOP_HANDOFF=1`, `ocx --version` prints the package version from `package.json` and exits 0.


## Audit (independent, 01a11f6b): NEAR-PASS

Folded:

- Every consumer uses the flattened reader result: `record.cliExecutable`, `record.platform`, `record.kind` (020's `record.bundle.cliExecutable` examples are superseded) in the handoff, diagnostics and test helpers; the real-launcher smoke is required in C because typecheck does not read `.mjs` bodies.
- Windows path rule restated to match Rust exactly: absolute means a drive root (`C:\\` / `C:/`) or a `\\\\` or `//` prefix; the server/share parts are not checked. TS boundary tests include `//server/share/ocx.exe` (accepted), `\\\\server` (accepted, same as Rust), `\\ocx.exe` (refused), `C:ocx.exe` (refused).
- After #6807/#6809 land, PR 2's rebase rereads `structure/runtime.md` (600-line cap), `structure/ops/service-and-sidecars.md`, `structure/cli-management.md` and the installation page, and reruns the launcher/managing-cli tests.

