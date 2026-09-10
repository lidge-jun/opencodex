# 000 — fix-and-reimplement round: plan

Base: `dev @ 50e955604`. Continues the igwanu round, which merged six PRs and left
seven open. This round's mandate is narrower and harder: **fix what can be fixed,
reimplement what cannot, and merge both** — the user explicitly authorized pushing
to contributor fork branches this round.

## Re-verified state (2026-08-28, against `dev@50e955604`)

| PR | author | fork writable | behind | merge-tree | tsc on merged tree | own suite |
|---|---|---|---|---|---|---|
| #2747 | olddonkey | **yes** | 39 | CLEAN | OK | 15/0 |
| #2740 | luvs01 | **yes** | 39 | CLEAN | OK | 2/0 |
| #2693 | yxr1995-maker | **yes** | 131 | CLEAN | OK | 62/0 |
| #2638 | luvs01 | **yes** | 192 | CLEAN | OK | — |
| #2497 | MarcTCruz | **yes** | 399 | **CONFLICT** | unreachable | — |
| #2745 | lidge-jun | n/a | 39 | CLEAN | OK | — |

**#2693 passing 62/0 is the trap this round has to avoid.** Its own suite is green
and its three reviewer-reproduced defects are all real. A suite written alongside a
defect tends to encode it; that is why the reimplementation below is driven by the
defect list, not by the PR's tests.

## Contention

`src/server/responses/core.ts` — #2745, #2638, #2497.
`src/codex/auth-context.ts` — #2638, #2497.
Everything else is disjoint. Pairwise `git merge-tree` before any second one of the
three lands; textual mergeability is not behavioral compatibility on that boundary.

## Lane assignment

| WP | Doc | PR | lane | why |
|----|-----|----|------|-----|
| wp2 | 010 | #2747, #2740 | **FIX** | correct code, stale base only |
| wp3 | 020 | #2693 | **REIMPLEMENT** | three reproduced logic defects |
| wp4 | 030 | #2745 | **FIX or NEEDS_HUMAN** | OAuth credential boundary |
| wp5 | 040 | #2638 | **REBASE + verdict** | auth/routing boundary, 192 behind |
| wp6 | 050 | #2497 | **adjudicate** | OAuth refresh, conflicting, 399 behind |
| wp7 | 060 | — | close-out | ledger + verification |

## Loop-spec

- Archetype: spec-satisfaction repair. Each target has a verifier that defines done.
- Write scope: `devlog/_plan/260828_bugpr_fix_and_reimplement/`, `src/` and `tests/`
  changes needed to fix or reimplement a target, fork-branch rebases where
  `maintainerCanModify` is true, `codex/` branches, PR metadata.
- Out of scope: `main`/`preview`, releases, enhancement PRs, history rewrite on
  `dev`, approving my own PRs, pre-disclosure security notes in tracked dirs.
- Bounds: one `bun test` at a time; long suites on `lidge` via `ocx-run`. Never
  `OCX_TEST_NO_QUEUE=1` — remove a stale root-owned lock instead.

## Standing gates

1. Compile/test evidence from the MERGED tree, never the PR head.
2. Pairwise `git merge-tree` before two PRs sharing a file both land.
3. Green checks are not health unless `ci` / `test N/4` / `macos` are present.
4. **Green targeted suites are not health either — you chose the targets.** Any
   function whose behavior changes gets a differential probe over every arm.
5. `gh run rerun` replays the same commit; only a rebase moves the base.
6. A safety net that exists in code is not one that functions.
7. A regression must FAIL without its fix (mutation-verified) to count as evidence.

## Accept criteria (mirrored into goalplan criteria[])

- c1 — every target has a recorded terminal disposition verified against live `gh`.
- c2 — merged-tree compile/test gate ran for every candidate.
- c3 — each landed change carries a mutation-verified regression.
- c4 — `dev` advances only through PRs targeting `dev`; forks rebased, not rewritten
  beyond the authorized scope.
- c5 — every behavior-changing function is differentially probed across all arms.
- c6 — auth/credential/OAuth surfaces land only when proven safe, else
  NEEDS_HUMAN/UNSAFE with the exact unresolved question.
