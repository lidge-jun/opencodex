# 040 — Outcome

Closed 2026-09-14. Ten pull requests landed on `dev` across two merge rounds, run by
four worktree lane threads. `dev` ended at `e97ed7afd`.

## What landed

| Round | PR | Change | Merge | Exact-head CI |
|---|---|---|---|---|
| 1 | #4511 | native vision honors operator `modelCapabilities` | `10d61fc2b` | 34758154482 |
| 1 | #4512 | audio routes record the real upstream status | `9b2fc10bc` | 34758292008 |
| 1 | #4545 | restart refuses a version-skewed CLI (carries #4529) | `e30f1d27e` | 34775280313 |
| 1 | #4548 | bridge search model bound to the bridge backend | `1a9423469` | 34776449529 |
| 1 | #4547 | Devin catalog keeps `supportsImages` as a tri-state | `6329f3038` | 34775751844 |
| 1 | #4543 | Cursor replay refunds spare bytes to clipped arguments | `f7e4af080` | 34776361364 |
| 2 | #4553 | live-outcome booking regressions for #4512 | `2176c5bc0` | 34779112640 |
| 2 | #4554 | budget and ordering regressions for the refund pass | `56c956715` | 34779412583 |
| 2 | #4556 | Devin capability propagation and precedence | `72335fc6a` | 34782050873 |
| 2 | #4557 | counter-read folds for the propagation layer | `e97ed7afd` | 34783132657 |

Joint proof: post-merge `dev` runs 34778300807 at `866367a6f` and 34782580496 at
`72335fc6a`, both success with no failing jobs. Every merge verified the check
run's `head_sha` against the PR head immediately before merging, so no PR landed on
CI that described a different commit, and no merge was taken without observing CI.

Issues closed with merge references: #4501 and #4502 by repository automation,
#4529 naming #4545, and #4522, #4530 and #4516 by this unit after an independent
audit of each claim against the tree.

## What did not land, and why

**#4555 (#4519 endpoint destination policy) is green and deliberately unmerged.**
MAINTAINERS.md requires explicit security review for credential-handling changes,
and this endpoint receives the serving provider's API key as a Bearer token. The
`dev` self-integration exception covers a missing second approval; it does not
cover that review. An adversarial security review ran instead and returned **fail**
on a real finding: a provider keyed under a custom name with a loopback endpoint
used to arm and now disarmed with no operator-visible signal, because the config
load path runs no error function and the plan-time refusal is silent by design. The
lane fixed it with one deduped warning per provider and endpoint that names the
remedy and omits the URL. Head `e8b36b0e2` is green; the PR waits on @Ingwannu.

**#4527 stays open** because its fix, #4528, is a draft whose author pushed a new
head mid-round; its runs were re-approved but it was never ready to merge.

Eleven issues were examined and deliberately left open with their residuals named,
including #4429, #4312, #4191, #4311, #3522, #3661, #4469, #4505 and #3506. The
closure cross-reference that opened this unit found an empty CLOSE-NOW list across
61 issues and 68 PRs, and that held: every close here was created by tonight's own
merges, not discovered in the backlog. No open PR was verified as superseded.

## What this unit learned

**A no-local-verification policy moves the cost to CI, and the cost is real.** L3's
first head failed the `gates` Typecheck step. That was found by repository CI,
relayed to the lane, fixed, and re-verified. Later a lane reported the stronger
fact: a fresh lane worktree has no `node_modules`, so a focused local run cannot
execute at all. Hosted CI is not merely the preferred evidence here; it is the only
evidence that exists.

**The lanes throttled themselves.** Each lane both pushed and dispatched CI
explicitly, producing eight full runs for four PRs and roughly two hundred jobs
competing for the same macOS runners. A push to a branch with an open PR already
queues a run; the explicit dispatch is a fallback for a rebase or base sync, which
is what the roadmap had meant. Four duplicates were cancelled and the rule was
corrected. Round 2 ran only `pull_request` events.

**A cancelled `dev` run is not a failure.** Twice a `dev` proof run was cancelled by
the concurrency group when a separate release train pushed a version bump. The
proof was retaken at the new tip both times. Read why a run cancelled before
treating it as red.

**Attribution has to be a trailer.** #4545 and #4553 both carry `Co-authored-by`
trailers, verified present in the squash commits after merging. Prose credit would
have vanished at squash time, which is how the 27 entries in CREDITS.md happened.

**Every audit gate found something.** The roadmap audit returned near-pass on three
blockers including a carry that would have written `src/cli/` without the structure
obligation the plan assigned it. The round-2 audit found a diff sketch that
referenced variables not in scope and would have cost a CI round trip. The security
review found the silent regression. None of these were style notes.


## Post-delivery state

Written after the rounds closed, so the next reader knows what is still moving.

Two items are waiting on people rather than on work. #4555 is green at
`e8b36b0e202025780e84759542a78cb1488b2333` and needs the explicit security review
MAINTAINERS.md requires for a credential-destination change; the `dev`
self-integration exception covers a missing second approval and not that review.
#4528 had never run CI until tonight's approval, and its one failure is
`release version line > the in-tree version is never behind a released one` — a
stale-base failure caused by the release train opening `dev` at 2.55.0, not by
anything in the diff. The author was told that a rebase should clear it.

The thread heartbeat was repointed from the four finished lanes to exactly those
two pull requests. It is read-only by construction: an absolute no-write rule, and
an explicit instruction that a merge of #4555 notifies with the merge SHA and
leaves #4519 open for a human to close after checking the landed code. That rule
exists because an earlier draft of the same automation told it to close the issue
automatically, and an audit caught that `state == MERGED` is not the
verified-code-evidence standard this unit used for every other close.

Two details in that automation are worth keeping if it is ever rewritten. It must
not use `reviewDecision` to detect the reviewer: that field never says who reviewed,
and a COMMENTED security review leaves it at `REVIEW_REQUIRED`, which is the likely
shape of the review being waited on. And it keys the CI verdict off
`gh run list --workflow ci.yml --commit <full sha>` rather than the check-run array,
because the array mixes a cancelled entry with later successful copies of the same
name and cannot answer "is the current head green".

