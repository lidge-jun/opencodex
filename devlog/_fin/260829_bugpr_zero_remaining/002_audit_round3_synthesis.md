# 002 — A-gate audit round 3: the review gate had a real bug

Round 3 returned `VERDICT: FAIL` with one Critical blocker, and it was a genuine defect in
code I had just written and called a gate. Recording it plainly, because a gate that is
trusted without being attacked is decoration.

This was not the last correction. A later adversarial pass found seven reachable fail-open
paths in the gate, including pagination results combined with `jq add` so review objects
were merged and reviewers disappeared. Those defects were fixed publicly in #2837 and
covered by mutation checks that made the tests fail when the faulty logic was restored.

## The blocker (accepted in full)

`scripts/ci/assert-mergeable-review.sh` v1 selected **any historical** `APPROVED` review at
the current head. Two reachable sequences defeated it:

1. A maintainer approves commit `abc`, reads it again, and posts `CHANGES_REQUESTED` on the
   **same** commit. v1 still reported the PR as approved — it laundered a live objection into
   a green light, which is worse than having no gate.
2. One maintainer approves while another has an outstanding `CHANGES_REQUESTED`. v1 found the
   approval and ignored the blocker.

Separately, the review query ended with `|| true`, so a mid-pagination API failure kept
whatever pages had been fetched and read as "no approvals" — a failed lookup silently
degrading into a verdict. A gate that treats an error as data is not fail-closed.

## Fix

v2 collapses the review history to **each reviewer's latest substantive state**
(`sort_by(submitted_at, id) | group_by(user.login) | map(last)`), then:

- refuses if any maintainer's latest state is `CHANGES_REQUESTED`, regardless of other
  approvals;
- requires GitHub's own `reviewDecision == APPROVED` as a second, independent signal;
- requires a latest-state `APPROVED` bound to the exact head, by a non-author maintainer;
- drops `|| true` — every API or parse failure exits 2.

## Non-vacuity proof

The regression suite (`.tmp/bugpr-campaign/gate-regression.sh`, a fake `gh` on `PATH`, no
network) drives the exact cases the auditor named:

```
PASS  superseded   exit=1  FAIL: outstanding maintainer CHANGES_REQUESTED from: Ingwannu
PASS  concurrent   exit=1  FAIL: outstanding maintainer CHANGES_REQUESTED from: Ingwannu
PASS  pagefail     exit=2  FAIL: could not read reviews (API or pagination failure)
PASS  outsider     exit=1  FAIL: reviewDecision is 'REVIEW_REQUIRED', not APPROVED
PASS  clean        exit=0  OK: approved at head ... by maintainer Ingwannu
```

And the two logics disagree on the identical payload, which is what makes the suite
meaningful rather than self-congratulatory:

```
$ jq -r '[.[]|select(.state=="APPROVED")|select(.commit_id=="aaa")|.user.login]|unique|.[]'
Ingwannu                      <- v1: "approved"

$ jq -r 'sort_by(.submitted_at,.id)|group_by(.user.login)|map(last)|.[]|"\(.user.login) \(.state)"'
Ingwannu CHANGES_REQUESTED    <- v2: correctly blocked
```

Live behaviour after the fix:

```
#2836 exit=1   reviewDecision is 'REVIEW_REQUIRED', not APPROVED
#2798 exit=0   approved at head 856ad72d41... by maintainer Ingwannu (author olddonkey)
#2812 exit=1   outstanding maintainer CHANGES_REQUESTED from: Ingwannu
#2638 exit=1   outstanding maintainer CHANGES_REQUESTED from: Ingwannu
```

Note #2812 and #2638: v1 reported these as "no approval found", which was the right answer
for the wrong reason. v2 names the actual cause — a live maintainer objection.

## A second mistake, mine, caught by the same round

I pushed the keystone-based rebases of #2799 and #2798 to their contributor forks **before**
#2836 merged. Because the keystone commit was not yet an ancestor of `dev`, it appeared
inside those PRs' own diffs, which added `package.json` to a contributor PR and tripped
`hygiene`/`enforce-target` with `unsponsored_surface` — the contributors do not have push
permission, so the restricted path needs a sponsorship label they cannot supply.

Both branches were restored to their original heads (`e9a7bb7bb0`, `856ad72d41`), so the
PRs are back to the state their approvals describe. The lesson is now an ordering rule: a
dependent rebase is pushed only after its base commit is an ancestor of `dev`. Verifying a
rebase locally in a scratch worktree is free; publishing it early is not.

## Governance result at campaign close

GitHub cannot mark an approval as specifically a security review, and the campaign had a
more basic identity problem: every available credential authenticated as the repository
owner, so GitHub rejected formal self-review. Findings were posted as comments and fixed,
but credential-surface merges still lacked the required non-author approval. The review
gate work improved enforcement without closing that governance gap.
