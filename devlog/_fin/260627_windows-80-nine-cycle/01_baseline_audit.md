# 260627 Windows 80 Nine-Cycle Baseline Audit

## Scope

This audit closes Cycle 0 of the nine-cycle Windows hardening goal. It proves that the
multi-cycle plan is grounded in the current repository before source changes begin.

## Repository State

- Branch: `dev`
- Relevant existing plan source: `devlog/80_windows-codex-path-hardening/15_final_gpt_pro_plan.md`
- Cycle map: `devlog/_plan/260627_windows-80-nine-cycle/00_cycle_map.md`
- Current worktree policy: do not push, reset, force, or clean without explicit user approval.

## Cycle Map Verification

The cycle map contains ten PABCD work-phases:

1. Cycle 0 — Durable Slice Map and Baseline Audit
2. Cycle 1 — Responses Request Timeout Disable Hook
3. Cycle 2 — Passthrough Native Relay Wrapper Guard
4. Cycle 3 — Transport Close Logging
5. Cycle 4 — Windows Service Log Path and Wrapper Start Evidence
6. Cycle 5 — Windows Child Exit and Status Diagnostics
7. Cycle 6 — Task Scheduler XML Settings Hardening
8. Cycle 7 — Bun Runtime Override and Identity
9. Cycle 8 — PID Cleanup Robustness
10. Cycle 9 — Clone GUI Dev Experience and CLI Currentization

This satisfies the user's minimum nine PABCD repetition requirement while keeping each
cycle independently testable and commit-sized.

## Referenced Surface Verification

The planned source and test surfaces exist:

- `src/server.ts`
- `src/service.ts`
- `src/bun-runtime.ts`
- `src/process-control.ts`
- `src/cli.ts`
- `tests/service.test.ts`
- `tests/bun-runtime.test.ts`
- `tests/process-control.test.ts`
- `tests/cli-help.test.ts`
- `tests/server-auth.test.ts`

The planned function surfaces exist:

- `src/server.ts`: `trackStreamLifetime(...)`, `relayWithAbort(...)`, `Bun.serve(...)`
- `src/service.ts`: `installWindows()`, `stopWindows()`, `uninstallWindows()`
- `src/bun-runtime.ts`: `isRealBunBinary(...)`, `durableBunPath()`
- `src/process-control.ts`: `killProxy(...)`
- `src/cli.ts`: `printUsage()`

## Audit Limitation

`cli-jaw dispatch --agent Backend` was attempted for independent plan audit, but the
employee returned `Not logged in · Please run /login`. Local static audit was used as
fallback evidence for Cycle 0 only.

## Baseline Verification Commands

Use these commands at Cycle 0 check time:

```bash
git status --short --branch
bun test tests/oauth-status-privacy.test.ts tests/cli-help.test.ts tests/config.test.ts
bun x tsc --noEmit
```

## Cycle 0 Done Criteria

- Cycle map exists and includes at least nine work-phases.
- Baseline audit records current surfaces and dispatch limitation.
- Targeted baseline tests pass.
- Typecheck passes.
- No source commit is required because `devlog/` is ignored in this repository.
