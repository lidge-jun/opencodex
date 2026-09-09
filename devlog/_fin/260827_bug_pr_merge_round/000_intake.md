# 260827 bug-PR merge round — intake

Base: dev @ 9b838d062 (fast-forwarded from origin/dev on 2026-08-27).
Scope: the 12 open bug-labelled PRs named by the user.
Lanes: L1 commit-then-merge, L2 close + squash-merge, L3 cherry-pick, L4 reimplement.

## Method

Every PR head was fetched to a local branch (`pr<n>-check`), checked out into an
isolated worktree under `/tmp/ocx-tc-<n>`, and compiled with `bun x tsc --noEmit`
against the repository's own `node_modules`. Note this compiles the PR HEAD, which is
behind dev by 4 to 294 commits depending on the PR; the merged-tree gate a merge round
actually needs is in 005. This is the gate the repository's
`resolve-pr`-only CI does NOT run for draft PRs: a draft here gets
`enforce-target`, `hygiene`, `label`, `resolve-pr` and CodeRabbit, none of which
compile the tree. Two PRs (#2672, #2674) carry the full matrix because they are
authored by a maintainer.

## Compile gate result (2026-08-27, local, bun 1.4.0)

| PR | tsc --noEmit | note |
|---|---|---|
| #2694 | **FAIL (5 errors)** | see 001 |
| #2693 | OK | test-only diff |
| #2690 | OK | |
| #2684 | OK | |
| #2674 | OK | full CI green |
| #2672 | OK | full CI green |
| #2671 | OK | |
| #2663 | OK | |
| #2647 | OK | branch CONFLICTING against dev |
| #2639 | OK | but its own change fails an existing suite, see 002 |
| #2638 | OK | |
| #2497 | OK | branch CONFLICTING against dev |

Evidence: `/tmp/ocx-pr-typecheck.txt`, produced by `/tmp/ocx-tc-all.sh`.

## Mergeability and CI as reported by GitHub

| PR | draft | mergeable | review | checks of note |
|---|---|---|---|---|
| #2694 | ready | MERGEABLE | REVIEW_REQUIRED | all 5 pass |
| #2693 | draft | MERGEABLE | REVIEW_REQUIRED | CodeRabbit pending |
| #2690 | draft | MERGEABLE | REVIEW_REQUIRED | enforce-target FAIL |
| #2684 | draft | MERGEABLE | REVIEW_REQUIRED | enforce-target FAIL, label FAIL |
| #2674 | draft | MERGEABLE | — | full matrix PASS; base is #2672's head |
| #2672 | draft | MERGEABLE | REVIEW_REQUIRED | full matrix PASS |
| #2671 | ready | MERGEABLE | CHANGES_REQUESTED | all pass |
| #2663 | ready | MERGEABLE | REVIEW_REQUIRED | all pass |
| #2647 | ready | **CONFLICTING** | CHANGES_REQUESTED | all pass |
| #2639 | ready | MERGEABLE | CHANGES_REQUESTED | ci FAIL, macos FAIL, test 4/4 FAIL |
| #2638 | draft | MERGEABLE | CHANGES_REQUESTED | enforce-target FAIL, hygiene FAIL |
| #2497 | draft | **CONFLICTING** | REVIEW_REQUIRED | enforce-target FAIL, hygiene FAIL |
