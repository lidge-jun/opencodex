# 021 — bd2 Batch B landing record: rebase service, three carries

Every one of the three CONFLICTING bug PRs landed. None was closed as stale.

| Original | Carry PR | Merge SHA | Author preserved |
|---|---|---|---|
| #3168 remote GUI health | #3179 | `eceb02d9d331d3f97b8f0d338c2bcd951778eb5a` | Ingwannu |
| #3135 caller-main retry | #3180 | `634d9e5a03a6bd23c7eaea101ca712b456e15991` | luvs01 (3 commits) |
| #3148 Claude subscription | #3182 | `865a36ef04eb6395e617f94ed87aaa474a903444` | Veritas-7 (2 commits) |

All three proven ancestors of `origin/dev`.

## What the conflicts actually were

**#3168 — documentation only.** Both this PR and #3173 documented the same `/readyz`
protocol fields and the same retired `allowInsecureHttp` key, in the same week. Kept the
fuller wording on each side. No code conflicted.

**#3135 — two real fixes in one `if`.** #3176 had added a 5xx quota-outcome recorder inside
the `no-alternate` branch; #3135 widens the guard on that same branch to admit `main`.
Taking either side alone would have silently dropped a shipped fix. Both kept: the guard
excludes `pool`, `main-pool`, and `main`, with the recorder inside. The test conflict was
purely additive and both authors' cases are retained — 70 pass, 0 fail proves it.

**#3148 — a comment conflict hiding a real interaction.** The textual conflict was trivial
(`dev` had gained `explicitTarget` in the block whose comment the PR rewrote). The
interaction was not: resolving auth mode *before* adding credentials meant a machine whose
local environment reads as a Claude subscription stripped the admission token a **connected**
launch was explicitly constructed with. `tests/claude-cli.test.ts` caught it — expected
`ocx_data_connected`, received `undefined`. Fixed by gating the subscription strip on
`!explicitTarget`, with a regression.

That third one is the argument for doing rebases rather than asking contributors to. The
conflict a contributor would have resolved was one comment; the defect underneath it only
shows up when you run the suite against current `dev`.

## Security reviews recorded

#3135 and #3148 both touch credential selection. Reviews were written into their PR bodies
**before** merge, on the exact head — unlike #3176 in Batch A, where the review was recorded
retroactively. That ordering is the process correction from the A-gate finding.

## Count

Bug-labelled items: **19 → 16** (7 PRs + 9 issues).

## Why the rebase service is worth the maintainer time

Three PRs had been sitting `CONFLICTING`, which reads on the board as "waiting on the
contributor". None of them actually needed contributor judgment. What they needed was
someone to run the rebase against a `dev` that had moved 100+ commits, and two of the three
conflicts were in documentation both sides had written independently.

The cost was three cherry-picks and four conflict resolutions. The return was three bug
fixes landing that would otherwise have aged until they were stale enough to close.

The #3148 case is the one to remember: the *conflict* was one comment, but the *interaction*
underneath it broke the connected-runtime launch path, and only running the suite against
current `dev` surfaced it. A contributor resolving that conflict on their own stale branch
would have resolved the comment correctly and shipped the defect.

## Remaining after Batch B

7 bug PRs: #3164 #3144 #3138 #3121 #3112 #3109 #3003 — all `CHANGES_REQUESTED`, which is
Batch C (maintainer-owned) and Batch D (contributor-owned).
9 bug issues: #3155 #3152 #3150 #3141 #3136 #2999 #2813 #1527 #1419 — Batches E and F.
