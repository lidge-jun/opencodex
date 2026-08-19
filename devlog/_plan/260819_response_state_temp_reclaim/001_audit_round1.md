# Audit round 1 — independent adversarial review of the roadmap

Reviewer: independent `explorer` subagent, read-only, dispatched against this worktree
at `d75a2402f`. Verdict: **GO-WITH-FIXES (blockers=3)**. Main-agent judgment:
**near-pass** — every blocker is folded below as a concrete amendment; no blocker was
rebutted.

A first reviewer produced nothing across four wait cycles (~11 min) and was retired as
a failed dispatch; this is the replacement's round, with a tighter falsify-this packet.

## Confirmed by the reviewer

- **Root cause holds (Q1).** `recoverStaleResponseStateTemps` has exactly one call
  site — `state.ts:621` inside `ensureLoaded` — and `ensureLoaded` is reached only from
  `:991`, `:1073`, `:1185`, all request-path. The 60 s tick's existing
  `sweepExpiredResponseStates` (`:890`) touches only the in-memory map and never disk.
  No off-request-path caller exists, so the plan is not misdirected.
- **`sweepLiveness` is the right slot (Q2).** `sweepExpiredOnWrite`
  (`state-store-sweeper.ts:91`) is called from write paths — `key-failover.ts:171`,
  `subagent-model-fallback.ts:321`, `gcp-adc.ts:324` — and `runCallbacks` fans out to
  every registration, so a directory scan on `sweepExpired` would run `opendir` plus up
  to 4096 `lstat`s on hot write paths. `sweepLiveness` has exactly one caller, the
  interval body at `:161-162`, with `sweepDeadOcxStartProcessCache` as precedent for
  syscall work in that slot.
- **The sweeper is ungated (Q3).** `startStateStoreSweeper()` runs unconditionally via
  `background-lifecycle.ts:59` ← `:129` ← `index.ts:718`. Independently re-verified.
  Phase 1 therefore reaches every affected user.
- **Windows liveness is correct (Q5).** `process.kill(pid, 0)` maps to `OpenProcess`;
  `ESRCH` means gone, `EPERM` means alive-but-unsignallable, and `state.ts:520` treats
  only `ESRCH` as dead. No change needed.

## Blocker 1 (accepted, HIGH) — pid reuse makes the skip permanent

`state.ts:582` skips a temp whose pid is alive. The 15-minute gate at `:581` is a
LOWER bound, so it never expires the skip: once a dead writer's pid is reused by any
live process, that temp is skipped on every future pass forever.

This matters more than the original scheduling defect for the reported case. Reboots
recycle low pids deterministically, and the field report was specifically about
**per-reboot accumulation**. The scheduling defect explains why nothing cleaned up;
pid reuse explains why the files survived even the passes that did run.

**Amendment (phase 1, additive):** add a boot-time floor. A temp whose `mtimeMs`
predates system boot cannot belong to any currently-live pid, so the liveness check is
provably vacuous for it. Reclaim when `file.mtimeMs < bootMs - skew` in ADDITION to the
existing gates; every original guard stays intact. `bootMs` derives from
`os.uptime()` and becomes an injectable IO member for testability.

This moves phase 1 from "runs on a timer" to "actually reclaims the reported files",
so it belongs in the bottom layer, not deferred.

## Blocker 2 (accepted) — the callback must be synchronous and self-bounding

`runCallbacks` (`state-store-sweeper.ts:66-84`) discards a returned promise, so an
`async` reclaim would swallow every error and defeat its `try/catch`. The signature is
`() => number`, so the wrapper must be sync and return a real removed count.

The reviewer also notes the inverted risk: a synchronous scan BLOCKS the event loop, so
the startup-scale `maxEntries = 4096` budget is wrong for a 60 s repeating tick on a
slow or network-mounted config dir.

**Amendment (phase 1):** the wrapper stays synchronous, and the periodic path passes a
smaller `maxEntries`/`maxCleanups` budget than the startup path. Reclaim is idempotent
and repeats every 60 s, so a smaller per-tick budget loses nothing.

## Blocker 3 (accepted) — symlink resolution must be shared, not duplicated

The two-directory resolution lives inside `ensureLoaded` (`:604-625`). A callback that
swept only `getConfigDir()` would miss temps stranded in a symlinked snapshot's real
directory — the exact case the comment at `:606-610` documents.

**Amendment (phase 1):** extract `new Set([dirname(path), resolvedDir])` into one shared
helper used by BOTH `ensureLoaded` and the new callback, so the two surfaces cannot
drift. The 010 doc already sweeps both directories; this makes it a single source.

## Self-found defects (main agent, during WP0 verification)

- **(a) Phase 2's dry run is wrong as written.** `020` proposed reusing
  `recoverStaleResponseStateTemps` with a no-op `unlink`. But `state.ts:586-590`
  increments `removed` and accrues `bytesRemoved` only INSIDE the successful-unlink
  branch, so a no-op unlink reports `removed` as if files were deleted while
  `bytesRemoved` stays truthful — inverted from what the doc claims. `maxCleanups` also
  bounds a report-only pass. Phase 2 needs an explicit `dryRun` mode with its own
  accounting, not injected-IO trickery.
- **(b) The options type is not exported.** `ResponseStateTempRecoveryOptions`
  (`state.ts:507`) is module-private, so out-of-module IO injection does not typecheck.
  Phase 2 must export it or expose a purpose-built wrapper.

## Residual (not blocking, recorded)

The 24 MiB whole-file rewrite stays out of scope. It bounds the SIZE of each leaked
file, not the leak; changing it alters the continuation cache's durability contract and
deserves its own unit.
