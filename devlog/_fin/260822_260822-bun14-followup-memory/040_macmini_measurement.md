# 040 — macmini-cf live measurement protocol

Depends on: 010 landed on a testable branch. Feeds 020 Phase A verdict.

## Host facts (verified 2026-08-21)
ssh macmini-cf reachable (BatchMode OK), arm64, bun 1.3.14 installed → natural
1.3.14-vs-1.4.0 A/B host. zsh -lc PATH discipline.

## Protocol
1. Install test build: `npm pack` locally → scp tarball → `npm i -g <tarball>`
   on macmini-cf. Record ocx --version + bunVersion/bunRevision/bunRuntimeSource
   from /api/system/memory.
2. Baseline: default config; drive SSE churn (harness waves: SSE-normal,
   SSE-slow, SSE-abort, idle-recovery); sample /api/system/memory every 60s
   ≥30min. Capture extraMemorySize (010).
3. GC evaluation (020 Phase A): matched no-GC/GC cell pairs using the TWO CELL
   TYPES 020 defines, never one concurrent stream shared by both measurements.
   RSS cells stay idle through their +5s/+60s samples so the criterion-a
   evidence is uncontaminated; latency cells run their own identical
   post-intervention probe stream, and their p99 is the criterion-c oracle.
   Running an RSS cell under concurrent load reintroduces exactly the
   allocator-residual noise 020 split the cells apart to remove. Child-side
   SIGUSR2 GC with reported durationMs; three fresh-process runs; p99 latency
   delta ≤ max(5ms, 5%) acceptance; evaluate the 260731 gate verbatim,
   criterion by criterion.
4. smol A/B (030): if remote numbers wanted beyond the local gate, trigger
   storage jobs on both builds; record peak RSS delta.
5. Evidence: scalar-counter JSON only (watchdog privacy contract), committed
   into this unit.

## Acceptance mapping
goalplan c3: 020 carries macmini+local GC-gate numbers incl. latency pairs;
030 carries local A/B numbers; 010 records config/diagnostic-only rationale.
