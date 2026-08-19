# 260819 — response-state temp reclaim

## Objective

Abandoned `responses-state.json.ocx.<pid>.<seq>.tmp` files can accumulate without
bound. A field report described ~19.6 GB of these files on one machine. Make the
existing reclaim run on a schedule that does not depend on serving traffic, and give
an operator a way to reclaim them when the proxy will not start at all.

## Evidence (verified against this tree at 59964ad77)

- `src/config.ts:293` — `atomicWriteFileAsync` names its temp
  `${target}.ocx.${process.pid}.${++_atomicSeq}.tmp`. This is the exact reported shape.
- `src/responses/state.ts:26` — `SNAPSHOT_TOTAL_MAX_BYTES` is 24 MiB, and the snapshot
  is rewritten whole on every persist. One abandoned temp is therefore up to 24 MiB,
  which matches the reported 20–27 MB per file.
- `src/responses/state.ts:548` — `recoverStaleResponseStateTemps` already implements
  the reclaim, with a 15-minute age gate, a PID-liveness check, a regular-file check,
  and bounded scan/cleanup counts. **The reclaim logic is correct and is not the defect.**
- `src/responses/state.ts:621` — its ONLY caller is `ensureLoaded()`, which is lazy and
  runs on first continuation access (`state.ts:991`, `:1073`, `:1185`).

## Root cause

**Corrected after the late round-1 audit (`002_audit_round1_late.md`); the original
narrative here was falsified.** It claimed a crashing proxy never reaches the reclaim.
That is wrong: a temp only exists if a snapshot write ran, and every `schedulePersist`
site (`:897`, `:929`, `:956`, `:971`, `:1214`) is downstream of `ensureLoaded`, so a
process that produced a temp had ALREADY run the reclaim.

The reclaim runs **once per process, at load, before that process writes anything**.
Three properties then combine:

1. **One-shot per process.** `ensureLoaded` sets `loaded = true` and never sweeps again,
   so any temp a process abandons after startup is invisible to it forever.
2. **The 15-minute grace excludes the predecessor.** `:581` skips files younger than 15
   minutes, so a proxy restarting promptly after a crash cannot reclaim the temp that
   crash just produced — and by (1) it never looks again.
3. **`maxCleanups = 512` caps a single pass** below the ~816 files implied by
   19.6 GB ÷ 24 MiB, so even a well-timed sweep cannot drain the backlog in one pass.

A restart loop therefore accumulates monotonically: each process sweeps once, too early
to see its predecessor's fresh temp, then adds one of its own.

This is a scheduling defect, not a missing-feature defect. Both layers below move or
add a CALLER; neither loosens a reclaim safety gate.

**Second cause, found in audit round 1 (`001_audit_round1.md`).** Scheduling alone does
not explain the reported files surviving the passes that DID run. `state.ts:582` skips a
temp whose pid is alive, and the 15-minute gate at `:581` is a lower bound that never
expires that skip. After a reboot the original writer's pid is routinely reused, so the
file is skipped forever. That matches the reported symptom — accumulation measured per
reboot — more precisely than scheduling does. Phase 1 therefore ships a boot-time floor
alongside the timer; a reclaim that runs on schedule but still skips every file would be
a phantom fix.

## Scope

IN: caller placement for the existing reclaim; an operator-facing reclaim path.

OUT: the 24 MiB whole-file rewrite. Incremental snapshotting would reduce the blast
radius per failure, but it changes the durability contract of the continuation cache
and is a much larger risk surface. It is recorded here as a known residual, not
silently dropped.

OUT: `src/storage/cleanup.ts` temps (`:1073`, `:2420`). Different owner, different
lifecycle; if they share the defect it is a separate unit.

## Work-phase map (dependency-ordered — PHASE-SPLIT-01)

| # | Phase | Doc | Depends on |
|---|-------|-----|------------|
| 1 | Periodic reclaim + boot-time floor | `010_phase1_periodic_sweeper.md` | — |
| 2 | Operator reclaim via `ocx doctor` | `020_phase2_doctor_reclaim.md` | phase 1 |

Phase 1 makes a RUNNING proxy self-healing. Phase 2 covers the case phase 1 cannot
reach — a proxy that will not start — and reuses the reporting shape phase 1
establishes. The dependency runs upward, so the stack lands bottom-up.

Audit round 1 is recorded in `001_audit_round1.md` (research range, per LEXICO-SPLIT-01).

## Roadmap lock

This docs-only cycle closes with the map above final and 1:1 with the goalplan's
`wp1`/`wp2`. Both decade docs are written to diff-level precision, so each later cycle's
P begins by re-verifying its pre-written doc against the tree rather than designing then.
Appending a later work-phase stays allowed as a P-phase amendment if one is discovered.

## Stack plan (DEV-STACK-01)

Two layers. Phase 1 is mergeable alone and fixes the reported accumulation for every
user whose proxy runs at all; phase 2 builds on it.

```
codex/tmp-reclaim-2-doctor    → PR #2 (base: codex/tmp-reclaim-1-sweeper)
codex/tmp-reclaim-1-sweeper   → PR #1 (base: dev)
```

## Terminal criteria

- A proxy that never serves a continuation request still reclaims abandoned temps.
- A temp stranded by a reused pid across a reboot is reclaimed rather than skipped forever.
- An operator whose proxy will not start can reclaim them with a documented command.
- No live temp is ever removed: the age gate and PID-liveness check stay intact.
- `bun run typecheck` and `bun run test` green before either PR is review-ready.
