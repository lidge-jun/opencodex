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

**Bound it.** Shutdown cannot hang on a wedged `icacls`. The ACL helper already
has a bounded retry/timeout; confirm during P that the drain inherits a finite
worst case, and if it does not, add an explicit cap whose expiry leaves the
resident durably recorded rather than silently dropped.

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
3. Inject an ordinary non-timeout `icacls` failure: no stub installed, exactly one
   write-failure/tombstone, no owned spill or temp left. The code appears
   fail-closed (`src/lib/windows-secret-acl.ts:872`,
   `aec717722:src/responses/state.ts:261`) but the PR adds no test for it.
4. Force link failure into the exclusive-copy fallback, then fail destination
   hardening: destination removed, never returned as a ref
   (`aec717722:src/responses/spill-store.ts:286-315`).

## Docs

`structure/02_config-and-codex-home.md` describes the queueing but not shutdown
ordering. Record that graceful shutdown drains publication before the snapshot
flush, and why (the 2 MiB exclusion is what makes it load-bearing).

## Must not change

Non-Windows synchronous branches. Required-ACL policy — failure must keep
throwing; swallowing it publishes secrets fail-open. Global serialization of the
tail (parallelizing invites generation/cleanup races). The pending-byte cap and
compare-before-swap identity check.

## Carried follow-up (not a blocker)

If ACL hardening fails *and* unlink fails, cleanup is best-effort and a full
payload can remain on disk; whether another local user can read it depends on the
resulting NTFS ACL. Predates this PR, needs a real Windows host to settle. File
separately rather than expanding wp3.
