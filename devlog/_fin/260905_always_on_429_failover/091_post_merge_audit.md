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
