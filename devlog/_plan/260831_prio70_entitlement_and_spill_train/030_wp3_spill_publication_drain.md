# 030 — wp3: drain Windows spill publications at shutdown (#3011 / PR #3018)

Independent of wp1/wp2 — different files, no catalog code. Consumes `003`.
One PABCD cycle.

Branch: `codex/3018-shutdown-drain`, based on PR #3018's head `aec717722`.

## Disposition

Not "merge #3018". The PR's async publication is the right fix for the 47s
`/healthz` stall, but it creates a shutdown boundary it does not close. wp3 lands
the drain on top of the author's head, proves it, then merges the combined result.
Ingwannu's commit stays intact and credited.

## The blocker, restated

`responseSpillPublicationTail` is awaited only by
`flushPendingResponseSpillsForTests` (`aec717722:src/responses/state.ts:328`).
`flushResponseState()` — what shutdown actually calls
(`src/server/lifecycle.ts:492`) — awaits `persistGate` and the snapshot write, and
never the tail.

Oversized residents are excluded from snapshots
(`aec717722:src/responses/state.ts:1015`, cap 2 MiB at `:35`), so for a payload
over 2 MiB there is a window where the snapshot skips the resident *and* the spill
stub is not installed yet. `process.exit()` on the stop paths
(`src/server/lifecycle.ts:489`, `src/server/management-api.ts:278`,
`src/cli/index.ts:365`) also skips the writer's temp cleanup
(`aec717722:src/responses/spill-store.ts:467-505`).

Result: a lost continuation plus a possible orphaned temp. Before the PR the race
did not exist, because publication completed before the request returned.

## Change — drain to a stable fixed point

`src/responses/state.ts`: add a production drain and call it from
`flushResponseState()` **before** snapshot serialization.

```ts
async function drainResponseSpillPublications(): Promise<void> {
  // A settling job can append another to the tail, so one await is not a
  // fixed point: keep observing until the promise we awaited is still current.
  for (;;) {
    const observed = responseSpillPublicationTail;
    await observed.catch(() => {});
    if (observed === responseSpillPublicationTail) return;
  }
}
```

Ordering matters: draining *after* the snapshot keeps the bug, because the
oversized resident is skipped at serialization time.

`flushPendingResponseSpillsForTests` should delegate to the same drain so the test
helper and production cannot diverge.

### Bounding it (amended after audit round 1 — `004`, blocker 3)

The draft assumed the ACL helper's timeout made the drain finite. It does not.
`defaultAsyncIcaclsRunner` sets a timer that calls `proc.kill()` and then **still
awaits `proc.exited`** (`src/lib/windows-secret-acl.ts:329-347`). Killing is not
settling: a child that ignores the kill leaves that await outstanding, so a drain
that only awaits the tail inherits an unbounded shutdown wait.

The draft's fallback was also incoherent — it said cap expiry would "leave the
resident durably recorded", but the reason this bug exists is that residents over
2 MiB are *excluded* from the snapshot (`:1002-1018`). There is nowhere for it to
go.

So wp3 must define **settlement**, not just waiting:

1. Drain with an explicit wall-clock cap.
2. On expiry, take a real durable action. Falling back to the snapshot is not an
   option, for exactly the 2 MiB reason.
3. `Promise.race` alone is **forbidden**: a writer that publishes after snapshot
   serialization is the same lost-continuation bug wearing a timeout.

### The fallback must share the cap (audit round 2 — `005`, blocker 3)

Round 1 named a synchronous publication as the cap-expiry fallback without checking
its cost. Verified: the synchronous writer hardens the directory and the temp as
**separate** calls (`src/responses/spill-store.ts:324`), and each call resolves its
**own** budget — `HARDEN_DEADLINE_DEFAULT_MS = 30_000`
(`src/lib/windows-secret-acl.ts:255`, resolved per call at `:799`), with the
file's own comment documenting a ~90s timeout-path worst case at load and ~60.25s
on the owner path.

A 5-second drain cap followed by a 60-second fallback is not a bound. So:

1. **A budget split, not just a total** (audit round 3 — `006`). "Enter the fallback
   at cap expiry" and "the fallback uses the remaining budget" cancel each other: a
   drain that consumes the whole deadline leaves the fallback zero time. So reserve
   the slice up front — end-to-end budget `B`, drain cap `B - R`, fallback reserve
   `R`, and the fallback receives `R` rather than the remainder. `R` must cover one
   directory harden plus one file harden at a reduced per-call deadline, because
   those are two separate calls (`src/responses/spill-store.ts:324`).
2. The fallback **passes its reserved budget down** instead of letting each harden
   call open a fresh 30s window. `OPENCODEX_ACL_TIMEOUT_MS` proves the deadline is
   already parameterizable (`:799`); the plumbing is the work.
3. **Explicit ownership transfer.** When the drain abandons a job, mark the async
   writer superseded so a late completion cannot publish over the fallback's
   result. A late writer winning that race is the same lost continuation.

**A synchronous stall is acceptable here specifically.** Only the graceful-shutdown
path reaches `flushResponseState()`, and no request is being served — #3011 is
about the request path. But it is acceptable *only* with an enforceable end-to-end
deadline.

### The split condition is withdrawn (audit round 3 — `006`)

Round 2 claimed abandonment "leaves exactly today's behaviour". That was wrong, and
the error was measuring against the wrong baseline.

On `origin/dev`, oversized candidates are published **synchronously before the
request returns**: `admitOversizedCandidate` calls `writeResponseSpillDurably`
inline (`src/responses/state.ts:382`, `:393`). There is no shutdown-loss window on
`dev` for that case at all. This doc says as much a few paragraphs up — "before the
PR this race did not exist" — and then contradicted itself.

Abandonment is equivalent to **PR #3018's head**, which is exactly the state that
introduced the loss. Measuring a proposed regression against an unmerged PR instead
of `dev` is how a regression gets waved through.

So: wp3 lands the bounded fallback, or wp3 does not land. If the budget plumbing
proves larger than the drain, the correct move is to keep #3018 **unmerged** until
the drain is complete. `dev` is currently correct on durability and merely slow on
Windows. A 47-second stall is worse UX; a lost continuation is worse behaviour, and
we do not trade the second for the first.

`src/server/lifecycle.ts` needs no change — it already calls `flushResponseState()`
at the right boundary.

## Regressions (each driven red first)

`tests/responses-state.test.ts`

1. Gate ACL calls under `responses-state-spill`, queue a candidate, call
   `flushResponseState()`; assert it stays pending until released. Red at the PR
   head: the flush ignores the tail.
2. After release, the flush returns only once the stub is installed; then clear
   memory and verify restart replay. Payload **over 2 MiB** so an early snapshot
   cannot mask it.
2b. **Cap expiry enters the fallback.** Hold the ACL gate past the cap; assert the
   fallback path runs rather than the flush returning with the job outstanding.
2c. **The fallback respects the remaining budget.** With the cap nearly spent, the
   fallback must not open a fresh 30s harden window. Assert total elapsed stays
   inside the end-to-end budget.
2d. **A late async completion after cap expiry does not overwrite.** Release the
   gate after the fallback has published; assert the fallback's result stands and
   the superseded writer publishes nothing.

   (Round 1's list omitted all three of these, which is what let the unbounded
   fallback look acceptable.)
3. (**coverage, not red-first**) Inject an ordinary non-timeout `icacls` failure:
   no stub installed, exactly one write-failure/tombstone, no owned spill or temp
   left. Required-mode throws are at
   `src/lib/windows-secret-acl.ts:877,881` and the state catch is at
   `aec717722:src/responses/state.ts:261-266`.
4. (**coverage, not red-first**) Force link failure into the exclusive-copy
   fallback, then fail destination hardening: destination removed, never returned
   as a ref (`aec717722:src/responses/spill-store.ts:286-315`).

Audit round 1 established that 3 and 4 **already pass at the PR head** — the code
is fail-closed there and cleans up. Keep them as coverage for a path no test
touches, but do not present them as red-first proof. Only 1 and 2 are that.

## Docs

`structure/02_config-and-codex-home.md` describes the queueing but not shutdown
ordering. Record that graceful shutdown drains publication before the snapshot
flush, and why (the 2 MiB exclusion is what makes it load-bearing).

## Must not change

Non-Windows synchronous branches. Required-ACL policy — failure must keep
throwing; swallowing it publishes secrets fail-open. Global serialization of the
tail (parallelizing invites generation/cleanup races). The pending-byte cap and
compare-before-swap identity check.

## Carried follow-ups (not blockers)

`src/server/lifecycle.ts:489` does not itself call `process.exit` — the real exits
are `src/server/management-api.ts:280` and `src/cli/index.ts:360,370`. The bypassed
temp cleanup still follows, but attribute it correctly.

If ACL hardening fails *and* unlink fails, cleanup is best-effort and a full
payload can remain on disk; whether another local user can read it depends on the
resulting NTFS ACL. Predates this PR, needs a real Windows host to settle. File
separately rather than expanding wp3.
