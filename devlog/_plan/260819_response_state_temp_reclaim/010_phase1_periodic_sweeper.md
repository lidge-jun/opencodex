# Phase 1 — periodic reclaim via the state-store sweeper

## Thesis

Abandoned response-state temps are reclaimed on a timer, so a proxy that never serves
a continuation request still cleans up after a previous crash.

Amended after audit round 1 (`001_audit_round1.md`): the timer alone does not reclaim
the reported files, because a reused pid makes the liveness skip permanent. This layer
therefore ships the boot-time floor with it.

## Why the sweeper is the right owner

`src/lib/state-store-sweeper.ts` already runs every 60 s (`STATE_SWEEP_INTERVAL_MS`),
is started once per process from `startProcessLoops` in
`src/server/background-lifecycle.ts:59`, is `unref`'d so it cannot hold the process
open, and wraps every callback in try/catch with `logCallbackFailure`. The
`responses-continuation` store is ALREADY registered there
(`src/lib/state-store-registrations.ts:87`) for TTL eviction. Disk reclaim for the
same subsystem belongs on the same tick.

`sweepExpired` is the wrong slot: it is called by `sweepExpiredOnWrite`
(`state-store-sweeper.ts:91`) on write paths, and filesystem scans do not belong on a
write. `sweepLiveness` is the correct slot — it runs only on the interval tick
(`:162`), and "is the process that owns this temp still alive" is precisely a
liveness question.

## Change map

### MODIFY `src/responses/state.ts` — boot-time floor (audit blocker 1)

`recoverStaleResponseStateTemps` skips a temp whose pid is alive (`:582`). The 15-minute
gate at `:581` is a LOWER bound and never expires that skip, so a pid reused after a
reboot strands the file forever. A temp whose `mtimeMs` predates system boot cannot
belong to any live pid, so the liveness probe is provably vacuous for it.

Amended by audit round 2 (`011_audit_round2.md`): the original justification — "a temp
predating boot cannot belong to any live pid" — is FALSE under a container sharing the
config dir, suspend-excluding `os.uptime()`, and network mtime skew. The real safety
argument is that the unconditional 15-minute grace at `:581` stays AHEAD of this gate.
The boot floor only retires a liveness probe that has become vacuous.

Add `bootTime: () => number` to `ResponseStateTempRecoveryIO` (`:499`) AND to the
default literal `responseStateTempRecoveryIO` (`:524`, else typecheck fails):

```diff
 const responseStateTempRecoveryIO: ResponseStateTempRecoveryIO = {
   now: Date.now,
+  bootTime: () => Date.now() - uptime() * 1_000,
```

Hoist the probe ABOVE the loop (one syscall per scan, not per entry) and guard it:

```ts
const rawBoot = io.bootTime();
// Not finite or in the future: treat the floor as absent rather than trusting it.
const bootMs = Number.isFinite(rawBoot) ? Math.min(rawBoot, io.now()) : Number.NEGATIVE_INFINITY;
```

Then, per entry:

```diff
-    if (pid === process.pid || io.isProcessAlive(pid)) continue;
+    // After a reboot the original writer's pid is routinely reused, which makes the
+    // liveness skip PERMANENT: the 15-minute gate at :581 is a lower bound and never
+    // expires it. A temp older than this boot cannot be owned by the pid we would be
+    // probing, so the probe is vacuous and we retire it — we do NOT claim the file is
+    // provably dead. The unconditional 15-minute grace above remains the safety floor,
+    // which is what keeps this sound under a shared-volume container, suspend-excluding
+    // uptime, or a network config dir, where the computed boot can land after real boot.
+    const predatesBoot = file.mtimeMs < bootMs - BOOT_FLOOR_SKEW_MS;
+    if (!predatesBoot && (pid === process.pid || io.isProcessAlive(pid))) continue;
+    if (predatesBoot && pid === process.pid) continue;
```

`BOOT_FLOOR_SKEW_MS = 60_000` absorbs granularity only; it is explicitly NOT what makes
the change safe (the named failure modes are hours, not seconds). The
`pid === process.pid` guard is kept unconditionally: this process must never unlink its
own in-flight temp.

### MODIFY `src/responses/state.ts` — scan deadline (audit blocker 6)

An entry cap bounds syscalls, not time: 512 synchronous `lstat`s is 2-5 ms on APFS but
5-10 s on an SMB/NFS config dir, which would block the event loop and stall in-flight
SSE streams. Add a wall-clock deadline inside the scan loop, with the entry cap kept as
a backstop:

```ts
const SCAN_DEADLINE_MS = 25;
// inside the loop, alongside the existing bounds:
if (deadlineMs !== null && io.now() - startedAt > deadlineMs) break;
```

`deadlineMs` is an option, null for the startup path (unchanged behavior) and
`SCAN_DEADLINE_MS` for the periodic path. Reclaim is idempotent, so a truncated tick
simply resumes on the next one.

### MODIFY `src/responses/state.ts` — shared directory resolution (audit blocker 3)

The literal + symlink-resolved pair is computed inside `ensureLoaded` (`:604-625`). A
callback sweeping only `getConfigDir()` would miss temps stranded in a symlinked
snapshot's real directory. Extract it once and use it from BOTH callers:

```ts
/** Literal config dir plus the snapshot's resolved dir; identical when nothing is symlinked. */
function responseStateSweepDirectories(): Set<string> {
  const path = snapshotPath();
  let resolvedDir = dirname(path);
  try {
    resolvedDir = dirname(resolveWriteTarget(path));
  } catch {
    /* unresolvable link: sweep the literal dir only */
  }
  return new Set([dirname(path), resolvedDir]);
}
```

### MODIFY `src/responses/state.ts`

Add an exported wrapper next to `sweepExpiredResponseStates` (after line 899). It
resolves the same two directories `ensureLoaded` sweeps (literal + symlink-resolved),
and returns a removed count so the sweeper's `rowsRemoved` accounting stays truthful.

It MUST be synchronous (audit blocker 2): `runCallbacks` discards a returned promise,
so an `async` reclaim would swallow every error and defeat its `try/catch`. It also
passes a smaller per-tick budget than the startup path — 4096 entries is a startup-scale
budget, and a synchronous scan blocks the event loop. Reclaim is idempotent and repeats
every 60 s, so a smaller budget costs nothing.

```ts
/** Per-tick budget. Smaller than the startup budget: this runs every 60 s, synchronously,
 *  on the event loop, and any remainder is reclaimed by the next tick. */
const PERIODIC_TEMP_MAX_ENTRIES = 512;
const PERIODIC_TEMP_MAX_CLEANUPS = 64;

/**
 * Periodic disk reclaim for abandoned atomic-write temps. `ensureLoaded` sweeps once on
 * first continuation access, which never happens in the case that produces the garbage:
 * a proxy that crashes before serving a continuation request leaves its temp behind and
 * never reaches that path. Registered on the sweeper's liveness tick so reclaim does not
 * depend on serving traffic.
 */
export function sweepAbandonedResponseStateTemps(): number {
  let removed = 0;
  // The try encloses responseStateSweepDirectories() deliberately (audit blocker 4):
  // recoverStaleResponseStateTemps already swallows its own list/iterator failures, so a
  // catch around only that call would be unreachable. snapshotPath()/getConfigDir() can
  // genuinely throw, and that is the failure this guard exists for.
  try {
    for (const dir of responseStateSweepDirectories()) {
      removed += recoverStaleResponseStateTemps(dir, {
        maxEntries: PERIODIC_TEMP_MAX_ENTRIES,
        maxCleanups: PERIODIC_TEMP_MAX_CLEANUPS,
        deadlineMs: SCAN_DEADLINE_MS,
      }).removed;
    }
  } catch {
    /* best-effort: disk reclaim must never destabilize the sweeper tick */
  }
  return removed;
}
```

New import: `uptime` from `node:os`. `dirname`, `resolveWriteTarget`, and
`recoverStaleResponseStateTemps` are already in scope.

### MODIFY `tests/responses-state.test.ts` — existing fixtures (audit blocker 1)

The existing test at `:1522` ages fixtures exactly 60 minutes and keeps `live` via
`isProcessAlive`. On a host booted <60 min ago (a normal CI runner) the boot floor would
bypass that skip and delete `live`, turning `removed: 1` into `removed: 2`. Inject
`bootTime: () => 0` there and at `:1575` to pin the floor out of those cases.

### MODIFY `tests/state-store-sweeper.test.ts` — home isolation (audit blocker 5)

Once `sweepLiveness` is registered, the fake-clock test at `:132` invokes the REAL
reclaim, and that describe block sets no `OPENCODEX_HOME` — so the suite would
`opendir` the developer's real `~/.opencodex` and could unlink real temps. Point
`OPENCODEX_HOME` at a temp dir for that block.

### MODIFY `src/lib/state-store-registrations.ts`

Line 37 — extend the existing import:

```diff
-import { sweepExpiredResponseStates } from "../responses/state";
+import { sweepAbandonedResponseStateTemps, sweepExpiredResponseStates } from "../responses/state";
```

Line 87 — extend the existing registration rather than adding a second store, so one
subsystem keeps one row:

```diff
-  { name: "responses-continuation", sweepExpired: sweepExpiredResponseStates },
+  {
+    name: "responses-continuation",
+    sweepExpired: sweepExpiredResponseStates,
+    sweepLiveness: sweepAbandonedResponseStateTemps,
+  },
```

### MODIFY `tests/responses-state.test.ts`

Add a regression test asserting the reclaim runs without any continuation access —
the exact property that was missing. It must prove the negative: a stale temp is
removed while a live-PID temp and a young temp survive, with `ensureLoaded` never
driven.

## Scope boundary

IN: the wrapper, the registration, the test.

OUT: loosening any existing gate. The age gate, file-type check, unlink-only removal,
and `pid === process.pid` guard are unchanged; the boot floor is ADDITIVE and sits
behind the 15-minute grace.

IN (widened by audit round 2): `recoverStaleResponseStateTemps` gains the boot floor and
the scan deadline, and its existing tests at `tests/responses-state.test.ts:1522`/`:1575`
gain `bootTime` injection. The earlier "no changes to this function" boundary was
unachievable once the pid-reuse leak was accepted as in scope.

OUT: startup one-shot reclaim. The first tick lands 60 s after start, which is
adequate for a defect measured in months of accumulation, and adding a startup call
would put a filesystem scan on the boot path.

## Accept criteria

| # | Scenario | Observable proof |
|---|----------|------------------|
| 1 | Sweeper tick with no continuation traffic | stale temp gone; `ensureLoaded` never invoked |
| 2 | Temp owned by a live PID | survives the tick |
| 3 | Temp younger than the 15-minute grace | survives the tick |
| 4 | Reclaim throws (unreadable dir) | tick completes; other stores still swept |
| 5 | Temp predating boot whose pid is now LIVE (reuse) | reclaimed — the permanent-skip case |
| 6 | Temp predating boot owned by THIS process | survives; never unlink our own in-flight temp |
| 7 | Symlinked snapshot dir | temp in the resolved real dir is reclaimed |
| 8 | Temp predating boot but YOUNGER than the 15-min grace | survives — the grace outranks the floor |
| 9 | `bootTime` in the future / not finite | floor ignored; live-pid temps still skipped |

Criterion 4 is the activation scenario for the wrapper's catch
(C-ACTIVATION-GROUNDING-01): make `responseStateSweepDirectories()` throw — NOT `list`,
which the reclaim already swallows internally, and which would leave the catch
unreachable.
Criterion 5 is the activation scenario for the boot floor: without it the file is
skipped forever, so the test must fail if the floor is removed.
Criterion 8 proves the ordering that carries the whole safety argument.

## Verification

`bun test tests/responses-state.test.ts`, then `bun run typecheck` and
`bun run test` before the PR is review-ready (shared runtime + registration table).
Also `bun test tests/state-store-sweeper.test.ts`. Corrected by audit round 2: its
assertions do NOT change, because both the registration-name list (`:100`) and the
fake-clock test (`:132`) derive from `STATE_STORE_REGISTRATIONS` and we EXTEND the
existing `responses-continuation` entry rather than adding a store. That test does begin
invoking the real reclaim, which is why it needs `OPENCODEX_HOME` isolation.
