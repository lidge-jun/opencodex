# 001 — A-gate audit round 1: synthesis and plan amendments

An independent Sol-high reviewer audited the roadmap against live repository state and
returned `VERDICT: FAIL` with 8 blockers. Each is recorded below with its disposition.
Two were verified independently before acceptance, because a reviewer claim is evidence to
check, not a verdict to copy.

This document preserves the first audit round as historical evidence. Later rounds found
additional defects in the executable review gate and repaired them in #2837. The campaign
still closed with an open governance gap: credential-surface merges had independent review
comments, but no formal non-author approval, because every available credential resolved to
the repository owner and GitHub refused self-review.

## B1 (Critical) — inventory was stale: 16 bug PRs, not 14. ACCEPTED

Live query returns 16: the 14 triaged, plus **#2744** (missed) and **#2836** (the keystone
PR this campaign created, auto-labeled `bug`).

#2744 `Recover encrypted agent tasks on the combo path before failing closed`
(yxr1995-maker, draft, CONFLICTING/DIRTY, head `1d8e35462a`) changes 4 files:
`package.json`, `src/server/responses/core.ts`, and two agent-task-recovery tests.

Amendment: #2744 joins wp5. #2836 is wp8's own PR and needs no lane. The inventory is
re-queried at the start of every work-phase and again at closeout, because the set moves
while the campaign runs — this campaign itself proved that by adding a member.

## B2 (Critical) — wp8 omitted review of a restricted surface. ACCEPTED WITH CORRECTION

The reviewer is right that `package.json` is a restricted path
(`.github/scripts/pr-sponsored-surface.cjs`, under `// Dependency surfaces.`) and that
wp8's accept criteria did not mention review.

The reviewer's implied conclusion — that #2836 would be hygiene-blocked — is WRONG, and the
live gate says so: `hygiene = pass` on #2836. The reason is in the same file:
`assessSponsoredSurface` returns `[]` immediately when `authorHasPushPermission` is true,
because a maintainer's own change carries its own sponsorship. #2836 is authored by
`lidge-jun`, who has admin.

What survives is the governance point, and it is the stronger one: `MAINTAINERS.md` still
requires a non-author approval, and `gh pr view 2836 --json reviewDecision` returns
`REVIEW_REQUIRED` with no reviews. Self-approval is forbidden.

Amendment to wp8 accept criteria: a fifth criterion — the merge requires a non-author
**maintainer** approval bound to the exact head.

**Withdrawn in round 2.** The first version of this amendment allowed "or an explicit
recorded operator decision to admin-merge". The reviewer correctly identified that as the
very bypass B3 exists to close, and it is withdrawn: an alternative that permits skipping
the approval is not a gate. If the approval cannot be obtained, wp8 reports BLOCKED and the
operator decides — the campaign does not pre-authorize the bypass on their behalf.

## B3 (Critical) — `--admin` bypasses the approval gate; the guard was prose-only. ACCEPTED

Live `dev` ruleset: `required_approving_review_count: 1`,
`require_code_owner_review: true`, `dismiss_stale_reviews_on_push: false`, and
`current_user_can_bypass: pull_requests_only`. So an admin merge genuinely can bypass the
approval requirement, and GitHub cannot tell a security review from any approval.

Amendment — an executable, fail-closed pre-merge check for EVERY merge in this campaign.
Round 2 rejected the first version of this amendment because it only PRINTED reviews (a
command that exits 0 on an empty list is not a gate) and because it checked only
`user != author` when `MAINTAINERS.md` requires a *maintainer*. Both points are correct and
are now fixed in code rather than in prose: `scripts/ci/assert-mergeable-review.sh`.

It exits nonzero unless one review is simultaneously `APPROVED`, bound to the exact current
`headRefOid`, authored by someone other than the PR author, and authored by an account the
script parses out of the `## Current maintainers` table in `MAINTAINERS.md` — so the gate
cannot drift from the policy document it enforces. Merges then use
`--match-head-commit <SHA>`.

Proven non-vacuous against live PRs:

```
$ bash scripts/ci/assert-mergeable-review.sh 2798
OK: #2798 approved at head 856ad72d414f27556729d70ed077e04494bb7336 by maintainer Ingwannu (author olddonkey)
EXIT=0

$ bash scripts/ci/assert-mergeable-review.sh 2836
FAIL: #2836 has no maintainer approval bound to head befcac3e10ac175f9aa8de65a799abd0b5e8f7aa
  maintainer roster: Ingwannu lidge-jun
EXIT=1

$ bash scripts/ci/assert-mergeable-review.sh 2812
FAIL: #2812 has no maintainer approval bound to head 220a9048edc9e6715c0c4cf7f1388e26a016293e
EXIT=1
```

Residual limitation, stated rather than hidden: GitHub cannot mark an approval as
specifically a *security* review, so for security-boundary PRs the reviewer's own words are
read to confirm the approval addressed the security surface. That is a human judgment the
script cannot make, and pretending otherwise would be the same error as the prose guard.

## B4 (High) — #2638 and #2828 were assigned from stale review evidence. ACCEPTED

Both moved since triage. Live: #2638 head `375e6f8fb8`, ahead 6 / behind 0,
`CHANGES_REQUESTED` (bound to the older `c8556f3703`). #2828 head `019c792607`, ahead 5 /
behind 0, no longer draft.

Amendment: both leave the reimplementation lane and enter a current-head re-audit lane
(wp9). Discarding an author's branch because of a finding already fixed on a newer head
would be both wasteful and unfair to the contributor. Reimplementation stays available if
the current head still fails review.

## B5 (High) — rebasing destroys the exact-head-approved premise. ACCEPTED

`dismiss_stale_reviews_on_push: false` means GitHub will happily keep an approval that no
longer describes the code. The plan leaned on approvals granted to pre-rebase heads.

Amendment: after any rebase, the approval is re-earned on the new head (B3's check enforces
it mechanically). The reviewer's falsification work is recorded as supporting the plan: it
inspected the failing logs of #2822, #2821, #2796, #2835, #2797, and #2785 and found ONLY
the `release version line` assertion — no unrelated failure. The inheritance thesis stands,
now independently confirmed and additionally proven by #2836's own `test 2/4 = pass`.

## B6 (High) — verifier claims overstated. ACCEPTED, CAUSE CORRECTED

The reviewer found `bun x tsc --noEmit` exiting 1 with
`error TS2688: Cannot find type definition file for 'bun-types'`. Verified: the cause was
that this worktree had no `node_modules` at all. After `bun install` (103 packages),
`bun x tsc --noEmit` exits 0. So it is a usable verifier once dependencies exist — the
plan's omission was the bootstrap step, not the command.

Accepted without reservation: `bun run skill:surface` WRITES its target and is a generator;
the verifier is `bun run skill:surface:check`. Also accepted: `ocx-run` evidence is
meaningless unless the remote workdir is proven to be at the exact head SHA and the child
command actually exercises the change. Both are now required in the evidence format.

## B7 (High) — missed cross-lane collisions on `src/server/responses/core.ts`. ACCEPTED

The plan named only the `destination-policy.ts` collision. Live intersections:
`src/server/responses/core.ts` is touched by #2807 (wp4), #2497, #2638, #2793, and #2744.
`package.json` is touched by wp8 and #2744.

Amendment: wp4 (#2807) is serialized BEFORE every other core-touching member, and each
later core-touching member re-verifies against the accumulated `core.ts` rather than
against the tree it was written on.

## B8 (Critical) — #2798 called "no security surface". ACCEPTED

The hygiene gate's restricted list does clear all five wp2/wp3 members
(`restricted=NONE` for #2799, #2798, #2822, #2821, #2785), so there is no gate
misclassification. But `src/lib/destination-policy.ts` decides whether an OAuth bearer may
be sent to an overridden destination, and `MAINTAINERS.md` covers "other security-boundary
changes", not just the mechanical list. Calling it non-security was wrong.

Amendment: #2798 is security-gated in wp2 and needs a fresh exact-head security review
after rebase. #2812 (wp5), which edits the same file, inherits that classification.

## Residual disagreement

None outstanding. B2's gate mechanics were corrected and B6's root cause was corrected;
both underlying blockers were accepted rather than rebutted.

## New work-phase

wp9 — current-head re-audit lane for #2638 and #2828.
