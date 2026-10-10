# 000 — bug_label_drawdown: Plan

## Objective

Reduce open items carrying the `bug` label — PRs and issues both — from **24** to **3 or
fewer** (5 acceptable if the last few are genuinely blocked). Feature PRs and enhancement
issues are out of scope even when they look adjacent.

Inventory taken 2026-09-02.

**14 bug PRs:** #3177 #3176 #3174 #3168 #3164 #3151 #3148 #3144 #3138 #3135 #3121 #3112
#3109 #3003
**10 bug issues:** #3170 #3155 #3152 #3150 #3141 #3136 #2999 #2813 #1527 #1419

## Loop-spec

- Archetype: verifier-defined. Each item has a binary terminal state.
- Write scope: whatever a named bug requires, plus `tests/`, plus this devlog unit.
- Out of scope: releases, promotion to `main`/`preview`, npm publish, deployment,
  security-boundary rewrites beyond a named issue, other worktrees.
- **Verification policy (user-directed, binding):** never run the repository-wide local
  suite; push with `--no-verify` so no hook runs it either. Focused `bun test` files plus
  red-green proof. CI trails the work and is judged per batch.
- Merge mechanism: `gh pr merge --squash --admin --delete-branch`.
- **Rebase service is authorized.** A PR whose only defect is staleness gets rebased by us;
  when the contributor branch is unpushable, its unique commits are cherry-picked onto a
  `codex/` carry branch with author credit preserved and the original closed
  `landed-via-maintainer` naming the merge SHA.

## Work-phase map

| WP | Doc | Batch | Items | Depends |
|----|-----|-------|-------|---------|
| bd0 | 000 | roadmap | inventory + dispositions | — |
| bd1 | 010 | A: merge train | #3174 #3176 #3177 #3151 | bd0 |
| bd2 | 020 | B: rebase service | #3168 #3148 #3135 | bd1 |
| bd3 | 030 | C: changes-requested, maintainer-owned | #3112 #3109 #3003 | bd2 |
| bd4 | 040 | D: changes-requested, contributor-owned | #3144 #3138 #3121 #3164 | bd3 |
| bd5 | 050 | E: needs-info issue triage | #3155 #3150 #3141 #3136 #1419 | bd4 |
| bd6 | 060 | F: implementable bug issues | #3152 #3170 #2999 #2813 #1527 | bd5 |

## Batch A state at inventory

| PR | Draft | Merge state | CI |
|----|-------|-------------|-----|
| #3174 gui mobile overflow | no | BLOCKED | running, no failures |
| #3176 wrapped quota rotation | no | BLOCKED | no failures listed |
| #3177 413 context overflow | **yes** | BLOCKED | running, no failures |
| #3151 Hermes vision export | **yes** | BLOCKED | **ci fail + macos fail** |

`BLOCKED` here means "awaiting required review", not unmergeable — all four are
`MERGEABLE`. Draft status must be cleared before merge, and #3151's red CI must be
diagnosed rather than waived.

## Accept criteria

Mirrored into the goalplan as c-1..c-7. c-7 is the real bar: **open bug-labelled PRs plus
issues total 3 or fewer**, 5 acceptable with recorded blockers.

