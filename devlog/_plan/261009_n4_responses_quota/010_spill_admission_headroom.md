# 010 — wp1: spill admission reclaims the headroom it asks for (#6747)

## Root cause (verified at 730d898457)

`queuePendingResponseSpill` (`src/responses/state/spill-queue.ts:288`) refuses a
publication when `accounted + footprint + inherited > cap`, and before refusing calls
`enforceSpilledResponseBudget()` to reclaim room. That function
(`src/responses/state.ts:879`) starts with:

```ts
let spilledBytes = accountedResponseSpillBytes();
if (spilledBytes <= spillByteCap()) return 0;
```

so whenever the store is under the cap but the new publication would cross it, nothing is
evicted, the recheck fails, and the candidate becomes a `spill_failed` tombstone
(`replaceWithSpillFailure`). The reporter's isolated reproduction (900,000-byte cap,
~600,867 bytes stored, ~400 KB peak footprint) shows exactly this. The same zero-headroom
call exists in the shutdown fallback (`spill-queue.ts:424`). The path runs on the Windows
ACL async queue (`windowsSecretAclApplies()`); other platforms publish synchronously and
prune afterwards.

## Design

`enforceSpilledResponseBudget(requiredHeadroomBytes?: number)` gains an admission mode.
Called with no argument (mutation pruning, lazy load, periodic sweep) it is unchanged.
Called with a number — including 0 — it is an admission reclaim: it brings the store to
`cap - headroom`, but only when eviction can actually produce that room. Bytes eviction
cannot touch — in-flight reservations (including the shutdown fallback's own pre-reserved
footprint), job-owned superseded generations and unreclaimable paths — are
`pinned = accounted - spilledResponseBytes()`. If `pinned + headroom > cap` the
publication cannot fit no matter what is evicted, so admission mode evicts nothing and
returns 0; the caller's recheck then refuses. Because the feasibility check applies to
every admission call, a shutdown fallback with no superseded generation (headroom 0) whose
own footprint plus cleanup debt exceeds the cap also evicts nothing (audit blocker 2).

A reclaim is only as honest as its unlinks (audit blocker 1). `deleteResponseSpill`
swallows unlink failures while every caller has already dropped the entry from
accounting, so a locked victim would let admission publish against space that was never
freed. The existing per-path debt ledger in `spill-queue.ts`
(`chargeUnreclaimableSpillPath` / `reconcileUnreclaimableSpillPaths`) already models a
file a failed cleanup left behind and settles the charge once the path is gone. A failed
(non-ENOENT) unlink of a stable spill file now charges that path at its `payloadBytes`,
so the admission recheck — which reads `accountedResponseSpillBytes()` and therefore
`unreclaimableBytes` — sees the file and refuses. This applies to every deletion of a
stable spill, which closes the same hole for the existing zero-headroom pruning too.
The orphan sweep (`recoverOrphanedResponseSpills`) still removes such files after its
grace window, and the charge clears on the next accounting read.

Eviction order is unchanged: deferred superseded generations first, then installed spills
by `createdAt` with response-id tie-break. Pending candidates and job-owned generations are
not in the eviction list, as today.

### `src/responses/state.ts` (MODIFY)

Final shape of the function (comments elided where unchanged):

```ts
function enforceSpilledResponseBudget(requiredHeadroomBytes?: number): number {
  // Price in-flight publications too: a file being created by
  // `writeResponseSpillDurablyAsync` occupies the volume before it reaches `states`.
  let spilledBytes = accountedResponseSpillBytes();
  // Admission (#6747) passes the room its publication needs, 0 included. Evict only while that
  // room is still reachable: re-read accounting after each attempt, since a failed unlink stays
  // charged, and stop the moment the publication cannot fit so no unrelated continuation pays.
  const admission = requiredHeadroomBytes !== undefined;
  const headroom = admission && requiredHeadroomBytes > 0 ? requiredHeadroomBytes : 0;
  const feasible = (): boolean => !admission
    || (spilledBytes = accountedResponseSpillBytes()) - spilledResponseBytes() + headroom <= spillByteCap();
  if (!feasible() || spilledBytes <= spillByteCap() - headroom) return 0;
  const before = spilledBytes;
  // (unchanged deferred-first comment)
  while (spilledBytes > spillByteCap() - headroom && pendingSpillUnlinks.length > 0) {
    const ref = pendingSpillUnlinks.shift()!;
    spilledBytes -= ref.payloadBytes;
    deleteResponseSpill(ref);
    if (admission) spillCounters.headroomEvictions += 1;
    if (!feasible()) return before - spilledBytes;
  }
  // (unchanged createdAt ordering comment + sort)
  for (const [id, entry] of spilled) {
    if (spilledBytes <= spillByteCap() - headroom) break;
    spilledBytes -= entry.spill.payloadBytes;
    deleteEntry(id);
    if (admission) spillCounters.headroomEvictions += 1;
    if (!feasible()) return before - spilledBytes;
  }
  return before - spilledBytes;
}
```

`return` (not `break`) on infeasibility exits both loops, so a failed deferred unlink can
never fall through to evicting an installed continuation (audit round 3). A NaN or
non-positive argument still selects admission mode with zero headroom; `Infinity` is
infeasible and evicts nothing.

Metrics call (~line 1212), one added line:

```diff
     spillAclTimeoutMemoRefusals: spillCounters.aclTimeoutMemoRefusals,
+    spillCapacityRefusals: spillCounters.capacityRefusals, spillHeadroomEvictions: spillCounters.headroomEvictions,
```

`clearResponseStateMemoryForTests()` (lines 1324–1328) replaces its five field-by-field
counter resets with one call, so new counters cannot be forgotten:

```diff
-  spillCounters.writes = 0;
-  spillCounters.writeFailures = 0;
-  spillCounters.readFailures = 0;
-  spillCounters.aclRetryReturnedTimeouts = 0;
-  spillCounters.aclTimeoutMemoRefusals = 0;
+  resetSpillCountersForTests();
```

Line budget for `state.ts` (1352 now, cap 1371): function +11, metrics +1, reset −4,
import of `resetSpillCountersForTests` folded into the existing `./state/spill-failure`
import line (0) → **1360**. The ratchet is not raised.


### `src/responses/state/spill-queue.ts` (MODIFY)

```diff
-  enforceSpilledResponseBudget(): number;
+  enforceSpilledResponseBudget(requiredHeadroomBytes?: number): number;
 ...
   if (requireStore().accountedResponseSpillBytes() + footprint + inheritedBytes > requireStore().spillByteCap()) {
-    requireStore().enforceSpilledResponseBudget();
+    requireStore().enforceSpilledResponseBudget(footprint + inheritedBytes);
     if (requireStore().accountedResponseSpillBytes() + footprint + inheritedBytes > requireStore().spillByteCap()) {
-      noteSpillWriteFailure(null, "ECAPACITY");
+      noteSpillCapacityRefusal();
 ...
 // shutdown fallback: footprint is already in reservedResponseSpillBytes, so only the
 // superseded generation is additional headroom.
-      requireStore().enforceSpilledResponseBudget();
+      requireStore().enforceSpilledResponseBudget(supersededBytes);
       if (...) {
         if (requireStore().currentEntry(job.id) === candidate) {
-          noteSpillWriteFailure(null, "ECAPACITY");
+          noteSpillCapacityRefusal();
```

The pending-RAM refusal at `spill-queue.ts:272` keeps `noteSpillWriteFailure(null,
"ECAPACITY")`: it is a different limit and is not counted as a disk-cap refusal.

Both admission call sites always pass a number: normal admission passes
`footprint + inheritedBytes`, the shutdown fallback passes `supersededBytes` (which may
be 0).

### `src/responses/spill-store.ts` (MODIFY) — failed unlinks stay accounted

```diff
+type SpillUnlinkFailureObserver = (path: string, bytes: number) => void;
+let spillUnlinkFailureObserver: SpillUnlinkFailureObserver | null = null;
+/** The owner of spill accounting registers here; a file a failed unlink left behind must stay priced. */
+export function setResponseSpillUnlinkFailureObserver(next: SpillUnlinkFailureObserver | null): void {
+  spillUnlinkFailureObserver = next;
+}

 export function deleteResponseSpill(ref: ResponseSpillRef): void {
   if (!validSpillRef(ref)) return;
   const dir = responseSpillDirectory();
+  const path = join(dir, ref.fileName);
   try {
-    unlink(join(dir, ref.fileName));
+    unlink(path);
     fsyncDirectoryBestEffort(dir);
-  } catch { /* best effort */ }
+  } catch (error) {
+    // Still best effort, but no longer invisible: the file occupies the volume.
+    if (!isErrno(error, "ENOENT")) spillUnlinkFailureObserver?.(path, ref.payloadBytes);
+  }
 }
```

`src/responses/state/spill-queue.ts` registers the observer once at module load:
`setResponseSpillUnlinkFailureObserver(chargeUnreclaimableSpillPath)`, and
`resetSpillQueueForTests` keeps clearing `unreclaimableSpillPaths` (unchanged).
The existing `spillIoForTest.unlink` seam can force the failure in tests.

### `src/responses/state/spill-failure.ts` (MODIFY)

```diff
 export const spillCounters = {
   writes: 0, writeFailures: 0, readFailures: 0,
   aclRetryReturnedTimeouts: 0, aclTimeoutMemoRefusals: 0,
+  capacityRefusals: 0, headroomEvictions: 0,
 };
+
+/** Test-only: zero every spill counter, including ones added later. */
+export function resetSpillCountersForTests(): void {
+  for (const key of Object.keys(spillCounters) as Array<keyof typeof spillCounters>) spillCounters[key] = 0;
+}
+
+/** A publication refused because the durable spill cap could not make room for it. */
+export function noteSpillCapacityRefusal(): void {
+  spillCounters.capacityRefusals += 1;
+  noteSpillWriteFailure(null, "ECAPACITY");
+}
```


### `src/responses/state/metrics.ts` (MODIFY)

Add `spillCapacityRefusals: number; spillHeadroomEvictions: number;` to
`ResponseStateMetrics` and to the `computeResponseStateMetrics` params, passed straight
through. Both are cumulative, process-local integers; they carry no path, size or id.

### Tests

- NEW `tests/responses/responses-spill-admission-headroom.test.ts` (register in both
  layout files). Uses the Windows ACL lane seam (`forceWindowsAclLane`-style setup copied
  from `responses-state.test.ts`) and `setSpilledResponseByteCapForTests`. Cases:
  1. under-cap store, publication that fits only after evicting the oldest spill → the
     oldest is evicted, the new continuation spills, no tombstone, newest replay works,
     `spillHeadroomEvictions >= 1`, `spillCapacityRefusals === 0`, disk stays ≤ cap;
  2. exact fit → no eviction;
  3. impossible footprint (two envelopes > cap) → no existing spill evicted, refusal
     counted in `spillCapacityRefusals`, seeded continuation still replays;
  4. inherited (same-id) generation priced into the headroom;
  5. a second publication pinned in flight is not evictable and is counted as pinned.
  6. shutdown fallback with its footprint already reserved and a feasible superseded
     headroom → the oldest unrelated spill is evicted and the fallback publishes;
  7. shutdown fallback whose footprint plus superseded bytes exceed the cap → no unrelated
     spill is evicted, the candidate is tombstoned, reservations are released;
  8. deferred superseded generations are evicted before installed spills;
  9. after `flushResponseState()` and a reload, the newest continuation replays;
  10. shutdown fallback with **no** superseded generation whose footprint plus cleanup
      debt exceeds the cap → no unrelated spill is evicted, the unrelated continuation
      still replays;
  11. eviction victim whose unlink fails (`spillIoForTest.unlink` throws EBUSY/EPERM),
      two shapes: (a) the failure makes the publication impossible (cap 900, headroom 800,
      victims 500 then 300, the 500 fails) → the 300 continuation survives and still
      replays, admission refuses; (b) the failed victim is small and further successful
      reclamation still makes room → admission evicts the next victim and publishes.
      Bytes on disk never exceed the cap. Recovery: once the seam stops failing, the
      production orphan sweep (`recoverOrphanedResponseSpills`, advancing the test clock
      past its grace) removes the file, the charge clears, and the next admission succeeds.
      (c) a deferred superseded generation whose unlink fails, followed by an installed
      continuation (cap 900, headroom 800, deferred 500 fails, installed 300) → the
      installed continuation survives and admission refuses.
  Publication is serialized: tests must not assume two writers run at once.
- MODIFY `tests/server/memory-watchdog.test.ts`: the reviewed response-state field count
  (`toHaveLength(20)` at :232) becomes 22, the typed field list at :201 gains the two
  counters, and an assertion checks both are finite non-negative integers.
- MODIFY in place (no added lines) `tests/responses/continuation-dedup.test.ts` reviewed
  key list, and any exact-shape metric assertions that use `toEqual`.
- Existing `responses-state.test.ts` "refuses a publication whose peak footprint does not
  fit the disk cap" must still pass unchanged (footprint 2×seed > 1.5×seed cap → headroom
  collapses to 0).

### Docs

- `docs-site/src/content/docs/troubleshooting/windows-memory.md`: describe
  `spillCapacityRefusals` / `spillHeadroomEvictions` and that admission now evicts the
  oldest continuations to make room before refusing.
- `docs-site/src/content/docs/reference/management-api.md` memory row: name the two new
  fields.
- `structure/transports/responses.md` (owner of `src/responses/` per
  `structure/manifest.json`): state the headroom admission rule and the two counters.
  Counters are logical eviction/refusal events, not proof of a physical unlink.

## Verification

`bun test tests/responses/responses-spill-admission-headroom.test.ts
tests/responses/responses-state.test.ts tests/responses/continuation-dedup.test.ts
tests/responses/responses-spill-acl-recovery.test.ts tests/server/memory-watchdog.test.ts`,
`bun run typecheck`, the layout and file-size guards; the rest in hosted CI.

## Risks

Headroom eviction trades the oldest stored continuations for the newest one, which is the
existing retention order. A failed unlink is now charged until the file is gone, which can
temporarily lower usable capacity while a Windows lock or permission failure persists;
cleanup is eventual through the orphan sweep once the unlink can succeed. The extra
accounting reads per eviction run only on admission paths that are already over target.
