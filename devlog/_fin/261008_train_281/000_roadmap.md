# 261008 2.81.0 train: roadmap

Goal: session 01a11911-4ca5-7252-a072-a46c7de5e759, goalplan `release-opencodex-2-81-0-from-dev-after-a-final`.
Coordinator worktree: `.tmp/lanes/h-haiku-5-5` (branch `codex/train-281`, from dev `aeebf11e5a`).
Owner request (2026-10-08): close superseded items, resolve #6370 by our own design, track #6743 to merge,
stabilize Cross-platform CI to green, release.

## Phase map (dependency order)

| wp | Doc | Depends on | Exit evidence |
|---|---|---|---|
| wp1 | this file + 010-050 | none | docs audited, locked |
| wp2 | 010_superseded_sweep.md | wp1 | sweep table recorded; every close names its superseding change |
| wp3 | 020_6370_contract_c.md | wp1 | carry PR merged after every 020 regression row passes, review APPROVE, exact-head CI |
| wp4 | 030_6743_tracking.md | wp1 | #6743 merged after its owner thread finishes, or blocker recorded |
| wp5 | 040_ci_stabilization.md | wp3, wp4, wp7 | lane=all Cross-platform CI green on the final dev tip |
| wp6 | 050_release_2_81_0.md | wp5 | 2.81.0 on npm latest, GitHub release and latest.json verified |
| wp7 | 040_ci_stabilization.md (fix section) | wp1 | picker-startup fixture drains ACL hardening before removal; PR merged |

wp3, wp4 and wp7 run in parallel (different branches). wp5 starts only after wp3, wp4 and wp7 have all
landed (its P revalidates this; the goalplan edge for wp7 is recorded here because wp5 was registered before
wp7 existed), and its first step is the wp2 post-merge sweep on that tip; then the single final
cross-platform run (owner rule). wp6 consumes the green candidate. The goal is not complete until the wp2
sweep table for the final tip is recorded.

## Surfaces

- wp3 is a fork lane thread with its own worktree `.tmp/lanes/s-6370` (branch `codex/carry-6370-spend-pool`),
  because this session's source worktree is the coordinator one and branch writes elsewhere are guarded
  (WORKTREE-GUARD-04).
- wp4 is owned by thread 01a1199c-9aa9-7c43-8f2e-f13a7c191846; the coordinator observes until it reports
  done, then verifies and merges.
- wp5 fixes land as small PRs from the coordinator worktree.

## Rules for every wp

No workflow cancellation. Squash merges with `--match-head-commit`; `--admin` only after exact-head required
checks and an independent sol review. No rebases of conflict-free branches. Security notes stay in `.tmp`.
