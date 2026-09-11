# 020 — GC relief: measurement-first evaluation, then gated production hook

Depends on: 010 (diagnostics land first so the evaluation can read
extraMemorySize). THIS DOC LANDS NO PRODUCTION GC CALL BY ITSELF.

## Prior-decision constraint (controlling)

devlog/_fin/260731_macos_rss_retention/040_allocator_residual.md:139-161 bans
threshold/idle-triggered production `Bun.gc(true)` and defines the ONLY path
back: three fresh-process runs showing (a) ≥50% of post-load RSS growth gone by
60s after one GC, (b) repeatable across real workloads, (c) idle-only with
measured stop time and unchanged tail latency in a concurrent control, (d)
release-notes/API support on macOS. Written against Bun 1.3.x; Bun 1.4's
shared-allocator purge (000 C6) could flip the result — measure first.

## Phase A (this unit): harness-only evaluation on Bun 1.4

### Child GC control channel (audit r2 finding 1)

The measured proxy is a spawned child
(scripts/macos-rss-retention-harness.ts:626-638) that today only handles
SIGINT/SIGTERM (harness-child.ts:54-96) — no GC control exists. Add one:

- scripts/macos-rss-retention-harness-child.ts: subscribe `process.on("SIGUSR2")`;
  handler runs `const t0 = Bun.nanoseconds(); Bun.gc(true); const dur =
  Bun.nanoseconds() - t0` and writes `{type:"gc", at:Date.now(),
  durationMs:dur/1e6}` to stdout JSONL (same channel as "ready").
- scripts/macos-rss-retention-harness.ts: after each load cell (outside the
  latency-measurement window), `processHandle.kill("SIGUSR2")`, await the
  `gc` event line (timestamped receipt), then take the +5s and +60s samples.
- GC duration evidence = the child-reported durationMs, not parent guesswork.
(SIGUSR2 is available on darwin/linux — this harness is darwin-targeted;
Windows is out of scope for it, matching the existing script name.)

### Tail-latency control cells (audit r2 finding 2, r3 finding 1)

The gate's criterion (c) needs a causally connected control WITHOUT
contaminating the RSS criterion (a). The two criteria use SEPARATE cell types:

- RSS-retention cells: load stream → intervention (GC via SIGUSR2 with receipt,
  or matched idle wait in the control arm) → process stays IDLE through the +5s
  and +60s samples. No probe traffic; the +60s sample is pure post-GC idle
  evidence for criterion (a).
- Latency cells (separate fresh-process runs): load stream → intervention →
  identical POST-INTERVENTION probe stream in both arms; probe-stream p99 delta
  (GC arm − control arm) ≤ max(5ms, 5%) is the oracle for criterion (c), with
  the GC pause (child durationMs) reported explicitly. RSS numbers from these
  cells are recorded but non-normative.

Deliverable: numbers table in this unit (three fresh-process runs × matched
pairs, per 040 on macmini-cf and locally); verdict PASS/FAIL against the
260731 gate, criterion by criterion.

## Phase B (conditional follow-up cycle, only on Phase-A PASS)

- Idle gate: relief only when `getActiveTurnCount() === 0`
  (src/server/lifecycle.ts:263 — existing export, no new seam needed). Defer
  while busy; re-check next tick.
- Rate limit: OWN `lastReliefAt` (decoupled from lastWarnAt so warn cadence
  never suppresses first relief), floor 30min.
- Config: restart-only startup configuration from the config file
  (`memoryWatchdog: { gcRelief?: boolean; warnThresholdMb?: number }` in
  OcxConfig). NOT in the /api/settings PUT allowlist; restart-only semantics
  documented. warnThresholdMb validated at load: integer 256..65536, else
  ignored+warn.
- Wiring chain (audit r2 finding 3 — all three layers named):
  1. src/server/index.ts:729 — `acquireServerBackgroundLifecycle(applyPolicy,
     { memoryWatchdog: config.memoryWatchdog })`;
  2. src/server/background-lifecycle.ts:129-143 —
     `acquireServerBackgroundLifecycle` gains the optional second param and
     forwards it to `startProcessLoops(applyPolicy, opts)` (both the
     first-owner branch and no change for the re-acquire branch: watchdog
     options are first-owner-only, restart-only by definition);
  3. startProcessLoops passes `{ gcRelief, warnThresholdBytes, gc, isIdle }`
     into startMemoryWatchdog.
- Test seam (audit r3 finding 2): StartServerDeps (src/server/index.ts:437)
  gains an optional `memoryWatchdogDeps?: { gc?: () => void; sample?: () =>
  MemorySampleBase; now?: () => number; intervalMs?: number; isIdle?: () =>
  boolean }` forwarded through acquireServerBackgroundLifecycle alongside the
  persisted config options into startMemoryWatchdog (deps override config-
  derived defaults; production callers pass nothing). The startup integration
  test injects gc spy + over-threshold sample + isIdle=true + short intervalMs
  through this seam and asserts snapshot().gcRelief === true and the spy fired.

- snapshot() exposes reliefCount, lastReliefAt, gcRelief.
- Windows caveat: mimalloc page scavenging disabled by design (#34181) —
  relief mainly helps darwin/linux RSS.
- docs-site: troubleshooting page gains the new config keys (restart-only).

## Tests (Phase B)
gcRelief on + above threshold + idle → gc called once; busy → deferred;
second tick within 30min → suppressed by lastReliefAt even when a warn fired
earlier; gc throwing → tick survives; gcRelief absent → never called; config
bounds validation; the startup integration test above.

## Measurement claim
Phase A IS the measurement (040). Phase B lands only with that evidence
attached — goalplan c3 satisfied by construction.
