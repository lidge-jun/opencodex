# wt5 — Windows scheduler settle + Bun provenance diagnostics (research)

Worktree: `/Users/jun/.codex/worktrees/bdbb/opencodex` (branch `codex/wt5-windows-service`, off `dev`).
The originally scaffolded `260802-wt5-windows-service` checkout was empty and has been removed; this
checkout owns the branch.
Two must-fix bugs in service install/diagnostics.

## Scope

### Bug A — PR #868: scheduler registration verification never settles

- Root cause (from PR body, re-verify): post-create Task Scheduler verification retried non-transient states, so registration verification could fail to settle. Fix retries only transient post-create visibility/XML health states, preserves fail-closed behavior for conflicts/missing assets/unknown SCM status, and stops late reconciliation when attempt ownership changes.
- Grounding: `src/service.ts`, `src/lib/winsw.ts`, `src/lib/windows-elevation.ts`; verification contracts in scheduler/startup/install tests (PR claims 136 focused tests).
- Severity: medium-high — Windows service install reliability; fail-closed semantics must be preserved exactly.

### Bug B — PR #861 / issue #848: doctor repeats OPENCODEX_BUN_PATH guidance when override already active

- Root cause (owner-confirmed on `dev@fa5780d5`): the service/doctor path has the Bun version but no trustworthy runtime-origin field, so Windows `auto-known-bad` repeats the `OPENCODEX_BUN_PATH` instruction even when the override is already active.
- Fix shape (owner-directed, from issue #848 comment): propagate one allowlisted `override | bundled | process` provenance marker through every actual launcher (npm Node launcher, Windows scheduler, native WinSW, launchd, systemd); report unknown/absent for legacy payloads instead of inferring from the current shell (`durableBunRuntime()` at reporting time can mislabel the running process); keep `bunRevision` informational; preserve the conservative `auto-known-bad` result for canaries; document the provenance trust rule in `structure/05_gui-and-management-api.md`.
- Grounding: `src/lib/bun-runtime.ts`, `src/service.ts`, `src/cli/status.ts`, `src/server/management/system-routes.ts`.
- Severity: medium — diagnostics-only, but it sends Windows users down a wrong remediation path.

## Claim ledger

| # | Claim | Source | Status |
|---|-------|--------|--------|
| 1 | Windows scheduler verification can fail to settle on transient states | PR #868 body | code-verified (PR author claims live Windows validation) |
| 2 | Doctor mislabels runtime origin; repeats override guidance | issue #848, owner comment | verified by owner on dev@fa5780d5 |
| 3 | Conservative eager-relay policy must stay unchanged for canary Bun | issue #848, owner comment | verified directive |

## Out of scope

- Changing the conservative eager-relay capability policy for canary/unknown Bun builds.
- macOS launchd/systemd behavior changes beyond adding the provenance marker.
