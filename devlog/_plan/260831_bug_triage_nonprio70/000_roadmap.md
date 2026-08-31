# 260831 — bug triage round: everything the priority-70 train does not own

A concurrent session owns the >=70 train (`devlog/_plan/260831_prio70_train_round2/`):
issues #3071, #3032, #3026, #3029, #3008, #3019 and their PRs #3069, #3056, #3040,
#3020. This unit owns the rest of the open bug surface and drives it to zero, keeping
only the handful that genuinely cannot be resolved from this tree.

## Frozen snapshot

Taken 2026-08-31T15:45:55Z against `dev` = `b4303bb9e`. Anything opened after that
timestamp is queued for the next round and does not change this round's acceptance
scope.

**Bug issues (11):** #3070 #3068 #3064 #3059 #3051 #3024 #3021 #2999 #2813 #1527 #1419
**Bug-labelled PRs (13):** #3078 #3067 #3066 #3063 #3053 #3052 #3041 #3039 #3038 #3034
#3003 #3000 #2989
**Also in scope, not bug-labelled:** #3030 (`chore`), carried only as a wrong-branch
janitorial closure. Audit round 1 caught this misclassification; see `002`.

Issue #3009 and PR #3039 are in scope. They are easy to confuse with the train's #3008
and PR #3040 — different defect, different file, different lane.

## Why this roadmap is deliberately shallow

The prio-70 unit wrote six diff-level decade docs before implementing anything. That
worked for six deep defects. This round has twenty-five items whose correct
disposition is mostly *closure*, and pre-writing a diff for an item that turns out to
be already fixed is wasted precision that then has to be un-written.

So this document locks only what a roadmap must lock: the scope, the cluster
partition, the order, and the candidate disposition per item. **The diff-level design
for each cluster is produced in that work-phase's own A phase**, against the tree as
it stands when that phase starts, and recorded in the phase's own decade doc. This is
an explicit, user-directed deviation from DIFFLEVEL-ROADMAP-01.

## Disposition vocabulary

Every item leaves this round through exactly one of:

| verdict | meaning |
| --- | --- |
| `MERGE` | the PR is correct and complete; squash after exact-head CI |
| `CHERRY_PICK` | only part of the PR is correct; take those hunks |
| `REIMPLEMENT` | the diagnosis is right and the remedy is wrong; rewrite on `dev` with a red-then-green regression |
| `CLOSE_FIXED` | already fixed on `dev`; cite the commit |
| `CLOSE_INVALID` | the claimed code path contradicts the tree |
| `CLOSE_DUPLICATE` | name the survivor |
| `CLOSE_NOT_REPRO` | no reproduction is possible against current `dev` |
| `UNSOLVABLE` | stays open; name exactly what external input is missing |

A closure without a `file:line` or commit SHA in its comment does not count.

## Work-phase map

The order below is the audited order, not the original one. Audit round 1 found three
file collisions the first ordering ignored, two of them with the concurrent >=70 train
(`002`, findings 5-7). Train-blocked phases run late so an external dependency never
stalls the round.

| # | wp | cluster | items | candidate disposition | blocked by |
| --- | --- | --- | --- | --- | --- |
| 0 | wp0 | this roadmap + live rescan | all of scope | — | — |
| 1 | wp1 | closes with no code | #3068, PR #3030 | duplicate; wrong-branch | — |
| 2 | wp2 | model catalog dated variants | #3024, PR #3034, PR #3041 | widen the suffix one-way; cherry-pick the merge tests | — |
| 3 | wp3 | cursor discovery transport | #3051, PR #3052 | merge after rebase | — |
| 4 | wp4 | windows service and scheduler | #3064 + PR #3067, #3009 + PR #3039 | one reimplement, one merge-after-fix | — |
| 5 | wp7 | residual bug PRs | PR #3078, PR #3053 | reimplement on dev; merge | #3053 needs wp2 |
| 6 | wp6 | account-pool auth and quota | PR #2989, then #2999 + PR #3000, then PR #3003 | merge; portable rewrite; merge | #2999 rewrite needs #2989 first (same file); #3003 needs train #3020 |
| 7 | wp5 | upstream request and compact metadata | PR #3066, then PR #3063, then PR #3038 | merge; merge; close the duplicate | #3066 and #3063 share `openai-responses.ts`, so #3066 lands first and #3063 rebases onto it. Train #3089 merged at `a0d386b49`, so the external blocker is gone (`004`) |
| 8 | wp9 | residual issue fixes | #3070, #1527, #3021, #3059 | four bounded reimplementations | — |
| 9 | wp8 | closeout | — | receipts, residual set, final audit | all |

Each row is one full PABCD cycle. The candidate column is what this round's four
read-only `xai/grok-4.6` lanes concluded; none of it is binding until that phase's own
A phase confirms it against the tree as it stands then.

**Every phase re-reads `gh pr diff --name-only` for its own PRs before merging, and pairs
that list against every other PR it is about to touch.** #3063 grew from two files to
five during wp0 and picked up two train-owned files, which moved it from wp7 to wp5
(`003`); pairing then exposed that it also collides with #3066 (`004`). A file list
captured at scan time is not a fact about merge time, and neither is a blocker — train
#3089 merged at `a0d386b49` while this roadmap was being audited.

## Declared unsolvable

#2813 (needs a live Luna Reserve account's `/v1/models` and `/api/models` dumps) and
#1419 (needs macOS `.ips` crash frames on Bun 1.4.0, which the maintainer already
declined to claim was fixed). Both are argued in `002`. Two of the allowed three-to-four
slots are spent; the rest stay unspent until a phase earns one.

## Constraints this round runs under

- No local full suite. Focused `bun test tests/<file>.test.ts` or `bun run test:changed`
  only; whole-suite evidence comes from hosted exact-head CI or `ssh lidge`.
- Every commit and push uses `--no-verify`. `dev` is protected, so every change lands
  through a branch and a PR, merged after exact-head CI is green.
- Read-only `xai/grok-4.6` lanes, unlimited, for investigation and audit.
- No file owned by the >=70 train is touched.

## Terminal outcome

`DONE` requires every scoped item terminal, at most four left open, each with a
recorded reason. Receipts land in `070_outcome.md`.
