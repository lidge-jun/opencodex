# 020 — wp2: make the spill disk cap hold during async publication (#3032 / PR #3032)

Score 75/80. Branch: `codex/3032-spill-budget`, based on `dev`. One PABCD cycle.

This is the same subsystem round 1's wp3 hardened (PR #3044, shutdown drain), so the
drain invariants are a constraint on this change, not background.

## The measured incident

6.8 GiB of spill accumulated in 44 minutes on the reporter's machine, ending in
ENOSPC. ENOSPC is what puts this at 20/20 on durability: it does not corrupt
OpenCodex state specifically, it breaks every durable write on the volume, including
ones belonging to unrelated processes.

## What the PR already gets right

At head `b4d1d2404f`: steady-state ordering, reload accounting, periodic enforcement,
and deferred-generation accounting. Six of its tests are real and non-vacuous for the
synchronous, load and sweep paths. Keep all of it.

## The one gap that blocks it

`spilledResponseBytes()` (PR-head `src/responses/state.ts:627-651`) counts installed
states and deferred unlinks. It does not count a file currently being created by
`writeResponseSpillDurablyAsync`. That publication stays live through
`src/responses/state.ts:246-300`, and `:174-179` allows up to 256 MiB of pending
payload, so on Windows — where ACL publication can block on `icacls` — the on-disk
total can exceed the advertised 1 GiB cap for as long as publication takes.

A cap that holds only when writes are fast is not a cap. It is the same shape of
defect as round 1's wp3 finding, where supersession reached the state tracking but not
the writer: the accounting and the filesystem disagreed about what existed.

## What changes

1. **`src/responses/spill-store.ts`** — expose an exact prospective measurement of the
   **peak publication footprint**, computed before publication rather than inferred
   after it. Exact, because an estimate that undercounts reintroduces the overshoot at a
   smaller magnitude and an estimate that overcounts drops replayable continuations.
   See the amendment below for why the peak is not one envelope.
2. **`src/responses/state.ts`** — reserve those bytes when a `PendingResponseSpill` is
   queued; include reservations in aggregate accounting; enforce the cap *before*
   creating the temp or destination file; release the reservation on every settlement
   path, including cancellation, supersession, and the drain's fail-closed
   `spill-failed` tombstone.

### Amendment after audit round 3 (`004`, blocker 1): supersession transfers, it does not release

"Release on supersession" is wrong for the shutdown path, and wrong in the most
expensive place. During drain expiry `supersedeShutdownFallbackBatch` marks every job
cancelled (`src/responses/state.ts:470`, `:542`), and `installShutdownFallbackSpill`
then performs a **synchronous** durable write (`:557`) whose own link →
exclusive-copy fallback holds temp and destination simultaneously
(`src/responses/spill-store.ts:370`).

Releasing at supersession therefore un-reserves exactly before the largest write of the
shutdown path. The async hole would be closed and a synchronous one opened in the code
round 1 of this train hardened.

So the reservation is **transferred** into the fallback rather than released:
supersession hands ownership to `installShutdownFallbackSpill`, and the bytes settle at
swap or terminalization. Cancellation that does *not* lead to a fallback write still
releases. The distinction to encode: cancelled means "this writer stops", not "these
bytes are gone".

### Amendment after audit round 4 (`005`, blocker 2): settle on every exit, not just the successful ones

"Settle only at swap or terminalization" leaks. `setResidentEntry` can make a queued
candidate stale through its failure branch **without cancelling the pending job**
(`src/responses/state.ts:781`), and the fallback loop then skips that job on the
`states.get(job.id) !== candidate` guard (`:546`) before the writer runs. Ownership was
transferred and nothing ever settles it.

Because reservations count against the cap, that leak is monotonic: every occurrence
permanently shrinks the usable budget until nothing can spill. A disk-cap fix that
ratchets the cap toward zero is a worse defect than the overshoot it replaces.

Transferred ownership must therefore settle on **every** exit from the fallback path,
including the pre-write candidate mismatch and any other no-swap/no-write return — not
only on the two success-shaped endings. The rule to implement against: a reservation is
owned by exactly one code path at a time, and every path that can stop owning it must
say so explicitly.

The release paths are where this will go wrong. Round 1 established that the drain
has five of them and that missing one wedges shutdown; every reservation must be
settled by the same code that settles the spill, not by a parallel bookkeeping pass.

## Regression

Gated Windows case in `tests/responses-state.test.ts`: lower the cap, fill active
spills to it, force link failure so publication takes the `COPYFILE_EXCL` fallback
(`src/responses/spill-store.ts:420`), block destination ACL hardening so the temp is
still present (`:627`), queue another spill, and assert that accounted and on-disk bytes
never exceed the cap while both the temp and the destination copy exist. After
settlement, assert the newest continuation is still replayable — the fail-closed path
must not become the ordinary path.

RED proof required: the assertion must fail against PR head `b4d1d2404f`, not just
against `dev`. This is the specific claim the PR does not yet satisfy, so a test that
is green on its head proves nothing.

Second RED case, added by audit round 3: force **drain expiry** so
`supersedeShutdownFallbackBatch` runs, then force synchronous link failure into the
copy fallback and inspect during hardening. Assert the reserved total still covers the
two-envelope peak at that moment. This one is red against the round-1 amendment as
written, and it is the assertion that proves the transfer semantics rather than the
release semantics.

Third RED case, added by audit round 4: queue a spill, make its candidate stale through
`setResidentEntry`'s failure branch so the job is never cancelled, then run the drain.
Assert the reserved total returns to its pre-queue value after the drain completes. Red
against the round-3 amendment, which leaks here.

## Constraint carried from round 1

The 1001-pass structural guard and the `B=5000`/`R=4000` budget split from PR #3044
must still hold. If reservation accounting interacts with the drain's fixed-point
loop, the loop's termination proof has to be re-argued, not assumed.

Both new RED cases must preserve that split and that guard while they run — a test that
demonstrates the cap by breaking the drain's termination has demonstrated nothing.

## Verification

Focused: `bun test tests/responses-state.test.ts tests/responses-state-write-amplification.test.ts`.
(`tests/responses-spill-store.test.ts` named in the first draft does not exist — blocker 8.)
Suite, typecheck and privacy scan on `ssh lidge`.

Residual risk, same as round 1's wp3: NTFS unlink semantics and `icacls` timeout
behaviour while a path is held still want a real Windows host.

## What implementation added beyond this plan

Four adversarial review rounds against the built branch (findings 4, 3, 1, 0). Three of
their findings changed the design rather than the code, so they belong here:

- **The footprint is measured, not estimated.** The plan said "exact prospective
  measurement" and the first implementation used `candidate.sizeBytes`, which omits the
  `version` field the published envelope carries. `prospectiveResponseSpillBytes` now
  shares `serializedSpill` itself, so the two cannot drift.
- **Superseded generations are priced in two places, not one.** A same-id replacement
  takes the old spill off `states` and hands it to the pending job. It is invisible to
  the accounting walk at admission (the job does not exist yet) and again in the shutdown
  fallback (supersession has already released the job). Both checks add it explicitly.
- **Cleanup debt is per path and repayable.** The plan did not anticipate a failed
  unlink. A flat charge that never decrements is phantom debt: a Windows lock that clears,
  or the async writer's own retry, removes the file while the charge stays, and two
  conservative 256 MiB charges consume the whole default cap for the life of the process.
  The debt is keyed by path and settled when the path is gone.
- **The shutdown fallback fails closed.** If the footprint still does not fit after
  reclaim, it terminalizes with ENOSPC rather than publishing onto an over-budget volume.

And one about verification: the first regression stayed green with the admission check
deleted, because `pruneResponses` reclaimed on another path. It proved the counter, not
the cap. There are now two tests — one for accounting during a forced copy fallback, one
for enforcement — and the enforcement test is red when admission is removed.
### Amendment after audit round 1 (`002`, blocker 3): the peak is two envelopes

The first draft reserved one serialized envelope. Windows publication can fall back
from hard-linking to copying (`src/responses/spill-store.ts:404`), and during that
fallback the destination copy exists while the temp file still exists and destination
ACL hardening is awaited (`:597`). Peak on-disk footprint for a single spill is
therefore two envelopes.

Reserving one leaves the cap violable by exactly the margin the issue reports, which
would have produced a phase that passes its own tests and does not hold its own
contract. The reservation is the peak footprint, and the RED test must **force the copy
fallback** while destination hardening is blocked, so both paths coexist at assertion
time. A test that only exercises the hard-link path cannot observe the overshoot.

If reserving two envelopes proves too costly at the cap, the alternative is to redesign
publication so the temp is released before the destination is hardened — but that
changes the crash-consistency story PR #3044 established, so it is a separate phase,
not a shortcut inside this one.
