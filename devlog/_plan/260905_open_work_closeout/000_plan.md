# 000 — Plan and live manifest

Unit: `devlog/_plan/260905_open_work_closeout`. Session `01a06e47-8897-70a0-b669-cf6c5b77d4c3`.
Snapshot: 2026-09-04T21:19:34Z (fetch), `origin/dev` = `0f27bbeb3`
(`test(hygiene): fail on duplicate test basenames, and close out the 429 unit (#3527)`).
Research worktree: `/private/tmp/ocx-closeout.xomWAA/wt` (detached).

## Objective

Triage and land every solvable open item in four families, as dependency-ordered PR
stacks merged bottom-up into `dev`. Constraints given by the maintainer:

- No repository-wide local suite. Verifiers: focused `bun test tests/<file>.test.ts`,
  `bun run typecheck`, `bun run test:changed`, exact-head hosted CI.
- Commit/push with `--no-verify` (the pre-push hook would run the forbidden suite).
- Stacked PRs (DEV-STACK-01..03), squash-merge bottom-up, admin merge authorized on `dev`.
- Carried or reimplemented contributor work carries a `Co-authored-by` trailer.
- Subagents: `anthropic/claude-opus-5`, unlimited.
- Out of scope: `main`/`preview` promotion, releases, credential/account changes.

## Work-phase map (dependency-ordered, one PABCD cycle each)

| WP | Scope | Doc |
|----|-------|-----|
| wp0 | Docs-only: manifest, lane research (001-005), dispositions (006), stack decade docs | 000-006 |
| wp1 | Stack A — bug PRs that are green/mergeable as-is | 010 |
| wp2 | Stack B — bug PRs needing rebase/carry/reimplementation | 020 |
| wp3 | Stack C — V2 passthrough #3444 | 030 |
| wp4 | Stack D — usage/quota PRs | 040 |
| wp5 | Stack E — remaining ready PRs + implementable bug issues | 050 |
| wp6 | Closeout: PR/issue closure, merge ledger, unit to `_fin` | 060 |

## Manifest (exact head at snapshot)

`gh pr view` at snapshot; columns: head, mergeable, mergeState, review, +/-, files, non-green checks.

| PR | Author | Head | Mergeable | State | Review | +/- | Files | Non-green checks |
|----|--------|------|-----------|-------|--------|-----|-------|------------------|
| #3529 | yansigit | 4f103a1e7 | MERGEABLE | BLOCKED (draft) | REVIEW_REQUIRED | 165/68 | 6 | — |
| #3525 | Ingwannu | 288506dc6 | MERGEABLE | BLOCKED | REVIEW_REQUIRED | 305/43 | 8 | — |
| #3524 | yansigit | cf0b3fe0a | MERGEABLE | BLOCKED (draft) | REVIEW_REQUIRED | 304/38 | 4 | hygiene FAIL, enforce-target FAIL |
| #3519 | everton-dgn | 6b92ab7db | MERGEABLE | BLOCKED (draft) | CHANGES_REQUESTED | 319/46 | 3 | — |
| #3515 | VXNCXNX | 4f09faf5d | MERGEABLE | BLOCKED | REVIEW_REQUIRED | 87/1 | 4 | — |
| #3502 | Ingwannu | 6671a1623 | CONFLICTING | DIRTY | REVIEW_REQUIRED | 461/104 | 30 | — |
| #3490 | yxr1995-maker | 3fbe8a2c7 | MERGEABLE | BLOCKED (draft) | REVIEW_REQUIRED | 159/1 | 4 | — |
| #3489 | Flowershangfromthebranches | dbcfde8ca | CONFLICTING | DIRTY | APPROVED | 586/5 | 6 | — |
| #3484 | Ingwannu | a4c50d104 | MERGEABLE | BLOCKED | REVIEW_REQUIRED | 187/1 | 14 | label CANCELLED |
| #3480 | benedictusrey | 63623c640 | CONFLICTING | DIRTY | CHANGES_REQUESTED | 11/0 | 2 | cancelled runs |
| #3469 | agentHits | e11089af8 | CONFLICTING | DIRTY | APPROVED | 115/3 | 6 | cancelled runs |
| #3407 | turin-dev | 38d45300a | CONFLICTING | DIRTY (draft) | REVIEW_REQUIRED | 295/33 | 18 | test 1/4, 2/4, gates, macos, ci FAIL |
| #3388 | zleo-ai | 007076ebd | CONFLICTING | DIRTY (draft) | REVIEW_REQUIRED | 843/4 | 5 | — |
| #3348 | RHODIZSECURITY | a64ed3250 | CONFLICTING | DIRTY | REVIEW_REQUIRED | 2165/196 | 35 | enforce-target CANCELLED |
| #3444 | cb8010d6 | baefb1334 | MERGEABLE | BLOCKED (draft) | REVIEW_REQUIRED | 111/4 | 6 | hygiene FAIL |
| #3447 | hualiny | 745b70e1e | CONFLICTING | DIRTY | CHANGES_REQUESTED | 567/9 | 3 | — |
| #2956 | Manson2438 | cc6aa5f48 | CONFLICTING | DIRTY (draft) | REVIEW_REQUIRED | 1261/114 | 34 | — |
| #2783 | lidge-jun | ad74f037d | CONFLICTING | DIRTY | CHANGES_REQUESTED | 6144/73 | 52 | — |
| #2973 | terrytan95 | b6a879267 | CONFLICTING | DIRTY (draft) | CHANGES_REQUESTED | 1025/60 | 33 | — |
| #3530 | lidge-jun | 14fbbd187 → MERGED 6580694c7 | — | MERGED during wp0 | — | 175/0 | 2 | follow-up E0 in 050 |
| #3323 | luvs01 | 0facdae69 | MERGEABLE | BLOCKED | REVIEW_REQUIRED | 6/4 | 1 | — |
| #3487 | Ingwannu | ee3b22d28 | CONFLICTING | DIRTY | REVIEW_REQUIRED | 6/1 | 1 | — |
| #3508 | yansigit | b78cadf12 | MERGEABLE | CLEAN | APPROVED | 316/0 | 2 | — |
| #3383 | x3M3x | 51726d2c7 | CONFLICTING | DIRTY | REVIEW_REQUIRED | 562/89 | 26 | — |
| #3329 | Veritas-7 | 1876d6001 | CONFLICTING | DIRTY | CHANGES_REQUESTED | 819/60 | 17 | — |
| #3421 | Skyline-23 | 432016100 | MERGEABLE | BLOCKED | CHANGES_REQUESTED | 327/89 | 16 | cancelled runs |
| #2716 | zigzag-007 | 27ba09f40 | MERGEABLE | BLOCKED | CHANGES_REQUESTED | 1325/3 | 17 | — |
| #2432 | mdwsk88 | c83d8eda1 | MERGEABLE | BLOCKED | CHANGES_REQUESTED | 26/18 | 9 | — |
| #3531 | benedictusrey | f486b5d60 | MERGEABLE | BLOCKED (draft) | REVIEW_REQUIRED | 74/3 | 6 | — |
| #3528 | benedictusrey | 735e3f5c5 | CONFLICTING | DIRTY (draft) | REVIEW_REQUIRED | 666/3 | 11 | cancelled runs |

Open bug-labelled issues at snapshot: #3522, #3506, #3467, #3464, #3462, #3433, #3425,
#3424, #3406, #3352, #3320, #3245.

## Research lanes (claude-opus-5, read-only)

| Doc | Lane | Items |
|-----|------|-------|
| 001 | bug PRs A | #3529 #3525 #3524 #3519 #3515 #3502 #3490 |
| 002 | bug PRs B | #3489 #3484 #3480 #3469 #3407 #3388 #3348 |
| 003 | V2 + quota | #3444 #3447 #2956 #2783 #2973 |
| 004 | else PRs | #3530 #3323 #3487 #3508 #3383 #3329 #3421 #2716 #2432 #3531 #3528 |
| 005 | bug issues | 12 open bug issues |

Dispositions are consolidated in `006_dispositions.md`; decade docs `010`-`060`
are the diff-level plans for wp1-wp6.

## Verifiers (PLAN-VERIFIER-REAL-01)

- `bun run typecheck` — exit 0 on current dev (run in research worktree at P).
- `bun test tests/<file>.test.ts` — named per landing in the decade docs.
- `gh pr checks <n>` filtered to the exact head SHA — hosted CI.
- `git fetch origin dev && git merge-base --is-ancestor <sha> FETCH_HEAD` — landing proof.
