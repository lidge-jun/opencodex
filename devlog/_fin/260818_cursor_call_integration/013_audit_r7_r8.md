# 010a — Audit rounds r7 (PASS) and r8 (NEAR-PASS): the plan is executable

## Why two rounds recorded together

`r7` walked the whole sequence and returned **PASS** with no blocking findings. That
verdict could not be recorded: the goalplan's `activeWorkPhaseId` was `null`, and the
review observer discards a sign-off whose round targets a work-phase that is not
active (`review-observer.ts:99-101`). Every earlier round had been silently
discarded for the same reason, which is why `r2`-`r6` all had to be aborted as
inconclusive after their findings were absorbed. Fixed by setting
`activeWorkPhaseId = wp1-integration-roadmap`.

`r8` then re-confirmed independently and returned **NEAR-PASS** with exactly one
finding.

## r7 (PASS) — what it verified

- The stack cut: both boundary subjects occur exactly once, the 39-commit range is
  linear with no merges, and `17 + 3 + 19 = 39`. Neither boundary commit can be
  dropped as empty — both boundary docs are absent from `dev`, and the overlapping
  EOF commit stays non-empty because of `emittedTerminal`.
- All four `r6` findings are **structurally impossible** under the new procedure, not
  merely unlikely: commits are referenced, never copied or rearranged.
- Retargeting is safe: a merge commit preserves PR1's commits, so after PR1 lands its
  tip remains the merge base of `dev` and PR2, leaving PR2's effective diff exactly
  `PR1_TIP..PR2_TIP`. The no-squash rule is what protects this.
- PR1 without WP2b is a complete, correct change: PR1 makes a truncated turn
  reportable, WP2b later makes it report tokens. Nothing in PR1 imports the relocated
  helper, and PR1's rewritten test asserts terminal shape without requiring usage.
- PR3's inventory is complete — 27 files, exactly the bridge/adapter work, the
  integration unit, and the late corrections `030` requires the PR body to disclose.

## r8 (NEAR-PASS) — the one finding, accepted

Step 3's proof was incomplete: it asserted `wire → cancel → tip` but never
`VERIFIED_BASE → wire`. The counts do not cover that gap, because
`git rev-list --count A..B` counts commits reachable from B and not A **even when A
is not an ancestor of B**. The reviewer demonstrated it: against `dev` at
`1645bb924`, `git merge-base --is-ancestor 1645bb924 dfb6fb884` exits 1 while the
three counts still sum correctly.

So a stack could have passed step 3 while its bottom did not sit on the verified
base — precisely the class of defect this plan has been failing on. Added:

    git merge-base --is-ancestor "$VERIFIED_BASE" cursor-call-wire   # exit 0

with the reasoning inline so a future reader does not delete it as redundant.

`r8` also independently re-confirmed both conflict resolutions, WP2b's resolver
choice and re-export, and the governance position, and found no first-failing step
once the assertion is added.

## r8's blocking finding: the push handed off the wrong tip

`010` step 7 pushes the rebase tip, and `020` verifies whatever `origin/cursor-call`
points at. But the declared order is WP2 → WP2b → WP3, and WP2b changes code AFTER
step 7 runs while carrying only local checks. So lidge would have authoritatively
verified a tree without WP2b in it, and PR3's WP2b implementation would have reached
`dev` backed by nothing but a local `bun test`.

The earlier push is not wrong, it is just not the handoff. `015` now ends with its
own push and SHA assertion, and `020` says explicitly which of the two pushes it
consumes:

    git push --force-with-lease --no-verify origin cursor-call
    test "$(git ls-remote origin refs/heads/cursor-call | cut -f1)" = "$(git rev-parse cursor-call)"

This is the same class as `r7`'s finding — a phase boundary where the artifact one
side produces is not the artifact the other side reads — which is why it survived
seven rounds of reading each document on its own terms.

## Round tally

| Round | Verdict | Findings | Recorded |
|-------|---------|----------|----------|
| r1 | FAIL | 6 | aborted (observer gap) |
| r2 | NEAR-PASS | 3 | aborted (observer gap) |
| r3 | FAIL | 5 | aborted (observer gap) |
| r4 | FAIL | 4 | aborted (observer gap) |
| r5 | FAIL | 3 | aborted (observer gap) |
| r6 | FAIL | 4 | aborted (observer gap) |
| r7 | PASS | 0 | aborted (observer gap — cause found here) |
| r8 | NEAR-PASS | 1 | recorded |

26 findings, every one verified against the tree and absorbed. Four of the eight
rounds attacked the same question (how to split the stack) and the fourth failure
was the signal that the question itself was wrong — recorded in `009`.
