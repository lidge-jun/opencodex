# 070 — closeout

Terminal outcome for the unit: **DONE**, with two items deliberately ending as
NEEDS_HUMAN and four as posted needs-info. Nothing was left silently open.

## What landed on dev

| PR | Author | dev sha |
|----|--------|---------|
| #3430 | ChickenBreast-ky | 4b53e1044 |
| #3401 | agentHits | 0f2e12099 |
| #3420 | ildunari | fc70555f3 |
| #3405 | adtumk | 20011a1c4 |
| #3439 | lidge-jun | 8401b68db |

Issues closed: #3428, #3400, #3378, #1527.

## What the merge train got wrong, and what caught it

Every one of the four contributor PRs was green on its own head, and the merge order was
audited for file overlap and semantic interaction before any of them landed. Both of those
checks passed, and the train still put two failing tests on `dev`.

The reason is structural: a per-PR gate tests each change against the `dev` it branched
from, never against the other changes in flight. #3430's own test pinned a downstream status
that a different code path answers differently, and #3401's TTY change invalidated a test
fake in a file it does not touch. Neither is visible until they share a tree.

The post-merge `dev` run is the only place that interaction appears, which is why it was
checked rather than assumed green. If this train had ended at "all four merged, all four
were green", `dev` would have stayed red and every contributor branching from it would have
inherited two failures that were not theirs.

## What was rejected, and why that is the useful part

Two planned fixes were discarded after reading the code they would have changed:

- **#3425's quota-selector fix** was contradicted by `tests/codex-routing.test.ts:325`, which
  already proves a known-100% account rotates away. The change would have been a no-op that
  additionally broke the never-primed case the source comments defend.
- **#3433's blanket `session_id` synthesis** would have bound unrelated callers sharing a
  cohort key onto one upstream session. Claude's implementation gates on
  `cacheKeySource === "metadata"` for exactly that reason; the Chat path has no equivalent
  provenance to gate on.

Both are recorded with their reasoning rather than quietly dropped. A plausible fix that the
existing tests already contradict is worse than an honest diagnosis, because it reads as
progress and ships a regression.

## Attribution

- #3403 was fixed in place on `ianlyoo:fix-dotted-tool-alias` so the PR stays authored by
  @ianlyoo, with `Co-authored-by` on commit e7fe8dc6e.
- #3439 carries `Co-authored-by` for @ChickenBreast-ky and @agentHits, whose tests it repairs.
- #3348 was offered the choice of splitting its own stack rather than being superseded
  unilaterally, with a `Co-authored-by` commitment if it is carried.

## Recorded exception

#3439 was merged with the owner `pull_request` bypass. GitHub refuses self-approval and
"Authors do not approve their own pull requests" governs regardless, so an ordinary review
was unavailable for a maintainer-authored fix. The bypass is recorded on the PR itself with
its reasoning, as MAINTAINERS.md requires, and @Ingwannu was asked for post-hoc review.

Holding it would have kept `dev` red for the duration.

## Filed

#3441 — `npm-global windows-latest` intermittently cancels at the global install step. Seen
on four runs across three unrelated branches, so it predates this work. Filed rather than
worked around, per the standing instruction about Windows failures.

## Final dev state: green

`dev` at `5ea3f2089` passes every job — `test 1/4` through `4/4`, `macos`, `gates`, the three
keyring jobs, `storage policy`, `api usage`, and `ci`.

Reading the intermediate red honestly matters here. The run on `8401b68db` — this unit's own
repair commit — was still red, and it would have been easy to read that as the repair having
failed. It had not: every failure on that sha traced to `tests/oauth-manual-code.test.ts:63`
tripping `privacy:scan` on a Muse key fixture introduced by #3437, which is why `gates` and
the `macos` suite both failed with the same message. #3443 fixed that fixture, and on the
next sha the shards that this unit repaired — `test 2/4` and `test 3/4` — are green.

Two separate regressions overlapped on the same branch within the same hour, from different
authors, and each initially looked like the other's. Attributing a red run to the change that
happens to be on top of it is the mistake that was available at every step here.
