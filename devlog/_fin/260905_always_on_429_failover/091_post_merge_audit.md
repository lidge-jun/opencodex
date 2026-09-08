# 091 — What the post-merge audit found

Both findings below came from re-reading the MERGED result against the tree, after the plan's
own criteria were satisfied. Neither was reachable from the plan, because both were created by
the fix itself.

## F1 — #3495 put a file read in front of every Anthropic request

`hasAnthropicFailoverQuorum` decides whether a request records the account that served it, so it
runs on the INITIAL resolution of ordinary traffic — not only after a 429. It calls
`getAccountSet`, which goes through `loadAuthStore`, and that has no cache: every call chmods the
config dir, chmods the secret, reads the whole credential file and normalizes it.

The generic twin had already hit this exact wall and documented it in
`src/oauth/generic-account-failover.ts`:

> Since presence now decides activation, this predicate runs on paths that have not seen a 429 at
> all […] so an uncached check would put a synchronous file read in front of every request for
> every OAuth provider.

I read that module closely enough to copy its activation semantics and not closely enough to copy
the cache that makes those semantics affordable. Fixed in #3503 by mirroring it: same 2 s window,
same "the cache holds a COUNT, never a credential" rule (here a boolean derived from one).

## F2 — the cache's invalidation was incomplete

Found while auditing F1's own fix. The cache was cleared on rotation and on pool-state reset, but
not on the two roster mutations that reach it from the management API. Deleting the second
Anthropic account left quorum `true` for up to 2 s — long enough for a request to record an id
whose credential was already gone.

`clearAnthropicSessionAffinityForAccount` (the DELETE route) and
`resetAnthropicRoutingForManualSelection` now invalidate too, so all four roster-mutating paths
are covered.

The regression test observes `atime` on the credential file rather than stubbing the module. A
mock would pass against a read reintroduced through a different call path; the syscall
observation would not.

## A CI lesson worth keeping

The macOS job failed on `npm launcher restarts the stopped runtime after a staged update`. I
called it a flake and reran — it had genuinely passed on rerun for #3499. It then failed a
**second** time, and the workflow log says plainly:

```
macOS suite failed on attempt N (exit …); assertion failures are not retried.
```

So the second rerun was never going to help, and the flake call should not have been repeated
without new evidence. The actual cause was not the diff — the test passes 15/15 locally and
imports nothing this unit touched — but that `dev` had moved to a 2-way macOS shard
(`4cacdfbb6`, #3501) after this branch point, which is the maintainer's own fix for the
resource pressure that was timing the job out. Rebasing onto it turned macOS green.

**Rule:** when a rerun fails the same way twice, stop rerunning and check whether the base
branch already carries the fix. A stale branch point is a cause, not a flake.

## A merge I should not have made

I merged #3523 on `gh pr checks` reporting five passes. The test and macOS jobs were still
**queued** — that command lists only the check runs GitHub has reported so far, so a partial set
reads exactly like a complete green one. A count of passes is not a statement that anything
finished.

The post-merge run on `dev` then showed `ci failure`, which was a genuinely alarming way to find
out. It turned out to be cancellation by the maintainer's next merge two minutes later, not a
real failure — every job read `cancelled`, not `failure`.

**Rule:** use the exact head SHA, require every expected aggregate or policy gate by name, and
also require zero non-terminal check runs. A missing check is not success. Paginate before treating
the returned set as complete:

```bash
set -o pipefail
gh api --paginate repos/<owner>/<repo>/commits/<sha>/check-runs \
  | jq -se '
      [.[].check_runs[]] as $runs
      | ["ci", "enforce-target", "hygiene", "react-doctor"] as $expected
      | ($expected - [
          $runs[]
          | select(.status == "completed" and .conclusion == "success")
          | .name
        ]) as $missing
      | [
          $runs[]
          | select(.status != "completed" or .conclusion == null)
          | .name
        ] as $pending
      | if ($missing | length) == 0 and ($pending | length) == 0
        then {ready: true, expected: $expected}
        else error("missing=\($missing) pending=\($pending)")
        end'
```

A clean result is `{"ready":true,...}` with exit status 0. This does not replace review-policy
checks such as confirming the approval belongs to the same head. Every `$expected` value is an
exact Checks API `.check_runs[].name`, not a workflow title or workflow-run name. If those required
check-run names change, update this list with the policy; silently accepting an absent name
recreates the original bug.

The near-miss paid for itself: sweeping `dev` afterwards found a real defect. #3511 and #3513
landed concurrently, one moving `anthropic-quorum-cache.test.ts` into `tests/routing/` and the
other placing a copy in `tests/adapters/anthropic/`. Different paths, so git saw no conflict and
both survived — a byte-identical duplicate running the same six tests twice. Removed in #3526.

## Reviewer credit

CodeRabbit caught that the first Claude Code guide assertion was too weak: requiring the intro to
mention `429` and carry emphasis is satisfied by the **original stale sentence**, so a revert
would have passed. Each locale now bans the phrase pattern that actually attributed failover to
the pool, and the test was driven red against the restored sentence before committing.
