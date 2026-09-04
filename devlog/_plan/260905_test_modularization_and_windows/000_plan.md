# 000 - Plan: test modularization and CI shards

Unit: `devlog/_plan/260905_test_modularization_and_windows/`
Session: `01a06d35-10d7-7c61-984c-60a8b27b8114` (HOTL goal loop)
Base: `dev` at `9c0e3ca80` (2026-09-05), branch `codex/test-modularization-260905`.

## Scope change (2026-09-05)

The unit was opened with a Windows-repair work-phase. The user then said the
Windows issues belong to someone else and this unit should only do test
structuring. wp1 closes as NOOP on that instruction; the Windows half of wp2
is dropped. The dispatch on `9c0e3ca80` (run 33894541984) was already queued
and is left to finish as baseline evidence only; its ref was deleted. The
directory name keeps `_and_windows` because the goalplan slug and ledger were
already bound to it; nothing else in the unit touches Windows product code.

## Objective

1. `tests/` holds 1053 flat files. Reorganize toward the layouts used by
   Codex CLI (`codex-rs/<crate>/tests/`) and Hermes (`tests/<domain>/`),
   without deleting or weakening any test, while `scripts/test.ts`,
   `scripts/ci/run-bun-test-batches.sh`, `ci.yml`, and the `test:changed`
   module-graph selection keep working.
2. Linux stays sharded and grows where it shortens the critical path; macOS
   gains shards. `platform-windows` stays `workflow_dispatch`-only and is not
   edited here.
3. A GitHub issue (feature template) describes the modularization proposal so
   the work is public and trackable, and links the PRs.

## Constraints

- No repository-wide local suite on this workstation. Focused files,
  `bun run test:changed`, typecheck, privacy scan, and exact-head CI are the
  gates. Full-suite measurements go to CI or to `macmini-cf` over SSH.
- Subagents: `xai/grok-4.6` (any parallelism, slow is fine) and `gpt-5.6-sol`
  at effort high only.
- Every PR targets `dev`, uses the PR template, and is merged by admin only
  after its exact head SHA shows `ci` success; ancestry proved with
  `git merge-base --is-ancestor`.
- Migration must not lose history: moves are `git mv`, one PR per domain
  group, so `git log --follow` survives and review stays bounded.
- Path literals that name `tests/...` (CI job lists, batch-script exclusions,
  source-oracle tests reading files as text, hygiene tests) are inventoried
  before any move and updated in the same PR as the move.

## Work-phase map (dependency-ordered)

| wp | doc | depends on | deliverable |
|---|---|---|---|
| wp0 | 000-009 + every decade doc | - | roadmap locked, goalplan refined |
| wp1 | `010_wp1_windows_noop.md` | wp0 | NOOP record (user instruction) |
| wp2 | `020_wp2_github_issue.md` | wp0 | modularization proposal issue filed with the feature template |
| wp3 | `030_wp3_layout_design_and_tooling.md` | wp0 | taxonomy, `scripts/test-layout/` mover + import rewriter + verifier, batch-script/ci.yml compatibility, hazard fixes; merged |
| wp4 | `040_wp4_migration_and_shards.md` | wp3 | migration PRs per domain group; shard plan applied; timings before/after |
| wp5 | `050_wp5_closeout.md` | wp2, wp4 | AGENTS.md / structure / docs-site updated; final CI proof; unit to `_fin` |

## Research docs

- `001_test_inventory.md` - counts, domain clustering, helper coupling, path-literal hazards.
- `002_reference_layouts.md` - how codex-rs and hermes place tests; lessons for Bun.
- `003_ci_timing_baseline.md` - per-job durations from recent green dev runs; shard math.

## Out of scope

Windows product or CI repair; release or promotion; npm publish; reducing test
count; editing other worktrees.

