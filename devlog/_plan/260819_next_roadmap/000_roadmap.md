# 260819 — Next roadmap (post-triage, post-cleanup)

> **Status: executed 2026-08-19.** R1-R4 are closed; see `050_execution_ledger.md`
> for what happened and `060_outcome.md` for the closeout. Two sections of this
> document were corrected by audit lanes during execution — the corrections are
> in `010` and `030`, and the reasons are in `050`. Read this file for the
> sequencing decision, not for current PR state.

Baseline: dev @ 3ad904e03 (local, 1 ahead of origin/dev 63bfd149d).
Inputs: the 260819 triage-execution outcome (12 merged, 5 downgraded), the
260818 mega-file split risk assessment, and a live read of 53 open PRs /
75 open issues on 2026-08-19.

This document is a sequencing decision, not an inventory. The inventory is in
`260819_triage_execution/030_outcome.md`; what follows is what to do next and
in what order, with the constraint that makes the order non-arbitrary.

## The one constraint that orders everything

Five files carry the repository: `responses/core.ts` (4532), `config.ts`
(3987), `service.ts` (3387), `registry.ts` (2692), `types.ts` (1884).
The split program wants to move all of them. Twenty-plus open PRs edit them.
A split lands as a whole-file rewrite, so **every open PR touching a split
file is rebased onto moved code the moment the split merges.**

The 000_risk_assessment already named this ("never interleave"). What has
changed since it was written is that the interleaving already happened: the
WP1 stack sat while 102 commits landed on dev, and it now conflicts.

So the order is: **drain the contributor queue first, split second.** Not
because the split is less valuable, but because the split's cost is
proportional to the size of the queue it has to rebase, and the queue is the
thing that decays if left alone.

## R1 — Unblock the split stack (this week, small)

The WP1 types stack is the cheapest split and it is currently the most
expensive to leave alone: it conflicts with dev today and the conflict grows
with every `types.ts` edit.

| PR | State | Action |
|---|---|---|
| #2019 WP1 | draft, 102 behind, red CI | rebase onto dev, re-run; the red is stale-base, not the change |
| #2023 WP1b | draft, child of #2019 | rebase after parent; green on its own base already |
| #2036 WP2a | draft, 42 behind | rebase; independent of WP1 |

**The red CI on #2019 is not a defect in the change.** Its failing shard
asserts `invalidateCodexModelsCacheWithPermit(permit, owningCodexHome)`,
a string that exists on the PR head and no longer exists on dev — dev removed
it in `6c0bde453`. The PR is running dev's newer test file against its own
older source. Three other shards fail the same way (hidden raw reasoning,
Command Code catalog, GUI models page). A rebase is the whole fix.

Both stacks also fail `hygiene: missing_regression_test`, which is correct
and not waivable by rebase: a pure-move PR changes `src/` without changing a
test. The honest resolution is `test-exception-approved`, not a decorative
test — the barrel's oracle is the existing 400-file import surface, and a new
test asserting "the barrel re-exports X" restates the compiler.

## R2 — Land the response-temp stack (ready now)

`#2084` (sweeper) and `#2089` (doctor) are the only PRs of ours that are
green, hygiene-clean, and 5 commits behind. `#2089` is `CLEAN`; `#2084` is
`BLOCKED` only by the review requirement.

Merge order is forced: `#2084` to dev, then retarget `#2089` from
`codex/tmp-reclaim-1-sweeper` to dev. Do not merge the child first.

This closes a real user-visible defect (multi-GB temp accumulation across
reboots) and the design holds up on read: the boot floor retires a vacuous
PID probe rather than claiming a file is dead, `eligible` is reported instead
of `matched` so the operator is not told live temps are abandoned, and the
dry run shares one predicate with the reclaim so report and removal cannot
disagree.

## R3 — Resolve the duplicate-fix collisions (before more arrive)

Three PRs fix the same `prompt_cache_retention` bug (#2092) three different
ways, and they are mutually incompatible:

| PR | Scope | Consequence |
|---|---|---|
| #2091 | strip for all ChatGPT-backend Responses | broadest; also drops it where a deployment honors it |
| #2099 | strip for `gpt-5.6*` prefix, forward mode | wrong branch (targets main) |
| #2102 | strip for `gpt-5.6`/`gpt-5.6-`, passthrough | narrowest and most precise |

Pick one and close the other two with the reason. On the evidence in the
issue, #2102's model-scoped strip is the defensible default: the backend's
cache behavior varies by deployment, so a global strip silently removes a
parameter some accounts accept.

A second collision: `#2056` and `#2062` both address K12 short-window quota,
and `#2062` targets main.

**Eight PRs currently target `main` and are auto-labeled `[WRONG BRANCH]`:**
#2110, #2109, #2099, #2082, #2063, #2062, #2032, #2029. These cannot merge
as-is. Retarget or close — leaving them open costs contributor goodwill and
re-triage time on every pass. Note that #2099 and #2062 appear in the
collision lists above, so retargeting them and picking a winner is one
decision, not two.

## R4 — The `modelRecordValue` family (one review, four PRs)

`#2077`, `#2085`, `#2086`, `#2100` are the same fix applied at four call
sites: a bare `map[modelId]` lookup where the runtime uses `modelRecordValue`,
so a `gpt-oss` entry fails to cover `gpt-oss:120b`. They are independent,
small, and each carries a focused test.

Review them as one batch with one shared verdict on the contract, then merge
individually. Reviewing them separately spends four reviews on one idea.

`#2077` additionally fixes a real crash path: a routed model id of
`constructor` or `toString` returned an `Object.prototype` function through
the prototype chain, which made `buildBehaviorFingerprintV1` throw inside a
linker that contractually does not throw.

## R5 — Then, and only then, the split program

Resume at WP2b (the stateful config train) with the sequencing rule from
000_risk_assessment intact: one work package per PR train, service and
registry never in the same change, Wave C never mixed with behavior fixes.

The rule that matters most is the oracle rule: a guard test rewritten in the
same PR as the code it guards must be driven red once against a deliberate
violation. `core-lab-boundary` and `repo-hygiene` already follow it; WP5
Wave C rewrites seven source-invariant tests and cannot be exempt.

## What this roadmap deliberately does not do

- **No new feature work is scheduled.** The queue has 53 open PRs; adding
  scope before draining it makes the split more expensive, not less.
- **`#1704` (combo quota badges) stays parked.** It is 817 commits behind and
  `CONFLICTING`. It is a re-cut, not a rebase, and it should be re-cut against
  the GUI as it exists after the split — not before.
- **The Antigravity stack (#2068-#2071) is not sequenced here.** Four PRs,
  ~5600 added lines, one author, all `BLOCKED`. It needs its own review lane
  and its own decision about landing order; folding it into a general roadmap
  would understate that.

## Branch hygiene (done 2026-08-19)

Local 106 -> 25, origin 66 -> 22. Every deleted branch was verified merged
into `origin/dev` or backed by a `MERGED`/`CLOSED` PR, with SHAs recorded in
`.tmp/branch-cleanup-*.txt` so any deletion is recoverable.

Release branches (`release-2.25.0`, `release-2.26.0` and their previews,
`codex/promote-*`) were deleted only after confirming each is an ancestor of
`main` or `preview` and preserved by its `v*` tag.

Six branches showed as "unmerged" while their PRs read `MERGED` — squash
merges, where the branch commit never enters dev's ancestry. Each was
confirmed by locating its merge commit in dev before deletion. A plain
`--merged` filter would have missed all six and left them to rot.
