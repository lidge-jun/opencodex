# 060 — wp6: #1429 / #1434, antigravity replay durability

## The defect (#1429)

A tool-call continuation on `google-antigravity` fails with HTTP 400
(`Function call is missing a thought_signature in functionCall parts`) whenever
the in-process reasoning-replay cache does not hold the signature. The cache in
`src/adapters/google-antigravity-replay.ts` is process-local with a 1h TTL, so a
restart loses every signature and the continuation cannot be replayed.

## What the contributor did (`89a96ce0e`)

Adds lazy snapshot loading, atomic persistence with permissions, load validation
and trimming, UTF-8 accounting, activity ordering, dirty generations, bounded
flushes, warning redaction, and test seams. `src/server/lifecycle.ts` flushes the
replay alongside response state and emits a sanitized shutdown warning on
rejection. Five locale docs describe `thoughtSignature` as opaque and document
restart-persistent snapshots.

Earlier review rounds already fixed forged `sizeBytes`, in-flight mutations,
surfaced persistence errors, load cleanup, activity ordering, duplicate keys,
UTF-8 signatures, and warning redaction. Two blockers remain.

## Blocker 1: flush budget exhaustion resolves instead of rejecting

`src/adapters/google-antigravity-replay.ts:253-261`:

```ts
for (let attempt = 0; attempt < REPLAY_FLUSH_MAX_ATTEMPTS; attempt += 1) {
  if (replaySnapshotPersistTimer || replayMutationGeneration > replayWrittenGeneration) {
    await persistReplaySnapshotNow();
  }
  await replaySnapshotPersistGate;
  if (replayMutationGeneration === replayWrittenGeneration &&
      replaySnapshotPersistTimer === null) return;
}
```

After eight non-converging attempts the function falls out of the loop and
resolves. `drainAndShutdown()` at `src/server/lifecycle.ts:440-445` then sees a
fulfilled promise and emits no durability warning, so shutdown reports success
while the latest thought signature may not be on disk. A flush that cannot prove
convergence must not look identical to one that did.

Fix: keep the bound, and after the loop throw a fixed non-sensitive error, e.g.
`throw new Error("Antigravity replay snapshot flush did not converge.")`. Fixed
text matters — the shutdown path logs it, and a message carrying session or
signature detail would leak through the warning.

Regression: a write seam that mutates replay state during *every* attempted
write; assert exactly `REPLAY_FLUSH_MAX_ATTEMPTS` attempts and
`await expect(flushAntigravityReplay()).rejects.toThrow(<fixed message>)`. The
existing blocked-writer test at line 756 covers one in-flight mutation, not
budget exhaustion.

## Blocker 2: snapshot cap ignores document framing

`src/adapters/google-antigravity-replay.ts:214-241` starts `total = 0` and counts
only per-entry bytes at 228-231:

```ts
const size = Buffer.byteLength(JSON.stringify(persistEntry), "utf8");
if (total + size > replaySnapshotMaxBytes) break;
total += size;
sessions.push(persistEntry);
```

The actual write at 236-240 serializes `{"version":1,"sessions":[...]}`, adding
the wrapper, brackets, and one comma per entry after the first. So the written
file can exceed the advertised `replaySnapshotMaxBytes` hard cap — a cap that is
wrong by a growing margin as entries accumulate.

Fix: seed the accounting with the exact UTF-8 prefix and suffix size, add one
comma byte for each entry after the first, serialize each entry once and reuse
those fragments to build the final payload, and add a defensive byte-length check
immediately before `atomicWriteFileAsync`.

Regression: at least three small sessions with the cap set just below the
complete three-session payload but above two; flush; assert multiple sessions
survive *and*
`Buffer.byteLength(<complete written snapshot>, "utf8") <= configuredCap`.
Asserting both halves keeps the fix from degenerating into "write fewer
entries."

## Verification

- `bun test tests/google-antigravity-replay.test.ts tests/shutdown-drain.test.ts`
  (baseline on the contributor head: 70 pass / 0 fail)
- `bun run typecheck`, `bun run privacy:scan`

## Landing

`pr/1434` is 9 commits ahead and 4 behind `dev`; it applies cleanly
(merge-tree `81807d7b3`). Land the contributor's commits preserving
`Yuxin-Qiao` as author, then one correction commit for both blockers.
