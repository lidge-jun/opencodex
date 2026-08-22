# 090 — Transactional update with rollback (#1942 / #1849 remaining half)

Follow-up on the landed foundation: 010 argv fix, 020 wrapper killer, 030/031
atomic replace + retry counters, d09c75299 missing-install wrapper guard.
This doc is the diff-level design for the half that is NOT built: stage-to-side
install, post-install verification, and rollback. No code in this doc's cycle;
it is consumed by a later implementation work-phase (one PABCD cycle).

## Problem restatement

update/job.ts today: pre-flight registry integrity probe (job.ts:1783-1801) →
npm install into the LIVE prefix → done. Failure after the old tree is removed
leaves a file-less skeleton (#1849) with no recovery; nothing verifies the new
tree before it becomes live (#1942). d09c75299 only stops the wrapper restart
storm after the damage.

## Design: stage → verify → swap → rollback window

### D1. Stage-to-side layout

- New module: src/update/transactional-install.ts (est. ~250 lines).
- Stage root: <prefix>/.ocx-staging/<version>/ — same volume as the live
  install so the swap is renameAtomicFile-eligible (030 foundation; cross-volume
  rename falls back to copy+fsync+rename per windows-atomic-replace.ts).
- npm install --prefix <stage> ${PKG}@<version> runs against the stage, never
  the live tree. Live tree untouched until verification passes.
- Disk-space pre-check: refuse staging below 2x package size.

### D2. Post-install verification manifest

- New file: src/update/install-manifest.ts. Verification rows:
  | artifact | check |
  | package.json | exists, parses, .version === target |
  | bin/ocx.mjs (+ platform launchers) | exists, non-empty, first line shebang/marker |
  | bundled Bun binary | exists, size > 10MB, spawn "--version" exit 0 |
  | node_modules sentinel deps | package.json of each direct dep exists |
- Verification runs INSIDE the stage before any swap. Failure = delete stage,
  report, live tree never touched. This alone closes the #1849 empty-install
  class.

### D3. Swap protocol (the transactional core)

1. Move live tree → <prefix>/.ocx-backup/<oldversion>/ (same-volume rename;
   wrapper killer from 020 stops running wrappers first, guard from d09c75299
   keeps restarts from racing the window).
2. Move stage → live (renameAtomicFile directory-level; on Windows retry class
   EBUSY/EPERM/EACCES via 031 counters, publisher id "update:swap").
3. Re-run the D2 manifest against the LIVE path (paranoia re-verify).
4. On success: delete backup after a grace period (next successful boot), not
   immediately — the running service that spawned the update may still hold
   the old cwd.
5. On failure at any step: rollback = reverse rename backup → live; if that
   also fails (double fault), leave backup in place and write a recovery
   marker file the wrapper guard (service.ts:1549) can print, so the user has
   a one-line restore instruction instead of a dead install.

### D4. Failure-mode table

| fault | state | recovery |
| stage install fails | live intact | delete stage, report |
| verify fails | live intact | delete stage, report |
| power loss during step 1 | live moved or partial | boot probe finds backup + no live → restore backup |
| power loss during step 2 | backup intact, live missing | same boot probe path |
| locked file during swap | retry class, bounded | 031 counters; exhaust → rollback |
| double fault | backup present, live broken | recovery marker + manual one-liner |

- Boot probe: new startup check in src/service.ts (est. +30 lines) — if
  .ocx-backup exists and live manifest fails, auto-restore before serving.

### D5. Wiring

- src/update/job.ts: replace the direct npm-install block with
  transactionalInstall() (est. -40/+60 lines); keep the pre-flight probe.
- CLI ocx update: same entry, shared module.
- Config: no new options (transactional is the only mode).

## Accept criteria / test plan

- tests/update-transactional.test.ts: fixture prefix trees; fault injection
  per D4 row (mock renameAtomicFile failures, kill mid-swap via step hooks);
  assert live-tree invariant (live is always either old-complete or
  new-complete, never partial) across every injected fault.
- tests/update-manifest.test.ts: each manifest row red/green.
- Windows CI leg (060 gate) must run both suites; the platform-windows
  dispatch flake documented in the campaign (Log Guard suites) is unrelated
  but must be green-or-baselined before trusting the leg.
- Issues #1942 and #1849 close only when the boot probe + swap land.

