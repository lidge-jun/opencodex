---
title: "M0-4: Memory recovery policy"
phase: "040"
depends: []
consumes: []
branch: codex/m0-4-memory-recovery
---

# 040 — M0-4: Connect watchdog to drain-and-restart

## Thesis

The memory watchdog (`src/server/memory-watchdog.ts`) observes and warns but never
acts. The drain-and-restart mechanism (`src/server/lifecycle.ts`) exists but is only
triggered by Dashboard UI. Connect them with an opt-in policy that auto-recycles
when memory pressure persists.

## Current state

- `src/server/memory-watchdog.ts`: 156 lines, warn-only, 4 GiB threshold, 60s sample,
  360-sample ring, uses `observedMemoryCounter` (max of rss/external/arrayBuffers)
- `src/server/lifecycle.ts:366`: `markRecyclingForExit()` + `drainAndShutdown()`
  exist and work for Dashboard recycle
- No watchdog → restart connection
- No consecutive-sample requirement
- No cooldown or max-per-day limit
- Watchdog comment says "threshold auto-restart is deliberately deferred"

## File change map

### MODIFY: src/types.ts (OcxConfig)

```diff
+ /** Opt-in memory recovery policy. When enabled, the watchdog triggers
+  * a drain-and-restart cycle after sustained memory pressure. */
+ memoryRecovery?: {
+   enabled: boolean;
+   /** Bytes threshold for recovery consideration. Default: watchdog warn threshold (4 GiB). */
+   thresholdBytes?: number;
+   /** Consecutive samples above threshold before triggering. Default: 3. */
+   consecutiveSamples?: number;
+   /** Cooldown minutes between recovery cycles. Default: 30. */
+   cooldownMinutes?: number;
+   /** Max recovery cycles per 24h. Default: 4. */
+   maxPerDay?: number;
+ };
```

### MODIFY: src/config.ts

Add Zod validation for the new config section.

### MODIFY: src/server/memory-watchdog.ts

Add recovery evaluation to the sample callback:

```diff
+ interface RecoveryState {
+   consecutiveAboveThreshold: number;
+   lastRecoveryAt: number | null;
+   recoveriesInWindow: { at: number }[];
+ }
+
+ function evaluateRecovery(
+   sample: MemorySample,
+   policy: Required<NonNullable<OcxConfig["memoryRecovery"]>>,
+   state: RecoveryState,
+ ): "trigger" | "cooldown" | "max-reached" | "below" | "accumulating";
```

When `evaluateRecovery` returns `"trigger"`:

```diff
+ // Verify supervisor viability before triggering restart
+ if (!canSupervisorRestart()) {
+   console.warn("[memory-recovery] threshold met but no supervisor detected; skipping restart");
+   return;
+ }
+ console.warn(`[memory-recovery] sustained memory pressure (${consecutiveAbove} consecutive samples above threshold); initiating drain-and-restart`);
+ markRecyclingForExit();
+ drainAndShutdown(serverRef, 60_000).catch(err => {
+   console.error("[memory-recovery] drain-and-restart failed:", err);
+ });
```

### NEW: src/server/supervisor-detect.ts

```ts
/**
 * Best-effort detection of whether this process is managed by a supervisor
 * that will restart it after exit. Checks:
 * 1. INVOCATION_ID env (systemd)
 * 2. Parent PID stability (launchd/supervisor patterns)
 * 3. Service command markers in argv
 * Returns false when unsure — recovery should not kill a standalone process.
 */
export function canSupervisorRestart(): boolean;
```

### NEW: tests/memory-recovery.test.ts

Test cases:
1. Disabled by default (no config) → watchdog warns only
2. Enabled + 3 consecutive samples above threshold → triggers restart
3. 2 consecutive + 1 below → counter resets, no restart
4. Cooldown enforced: second trigger within cooldown → skipped
5. Max per day enforced: 5th trigger in 24h → skipped
6. No supervisor detected → skipped with warning
7. `heapUsed` alone not used — observedMemoryCounter logic preserved
8. Active turns drained before exit (lifecycle contract)
9. Restart loop prevention: 4 restarts in short window → backs off

## Activation scenario

A process accumulates RSS to 5 GiB. With `memoryRecovery.enabled: true` and default
`consecutiveSamples: 3`, three 60-second samples all above 4 GiB → evaluateRecovery
returns "trigger" → supervisor check passes → drain active turns → exit → supervisor
restarts the process with clean memory.

## Scope boundary

IN: Config type, watchdog recovery evaluation, supervisor detection, lifecycle connection, tests
OUT: Changing the watchdog sampling interval, adding GUI for recovery settings,
     changing the 4 GiB default warn threshold, process-wide memory budget (P3 scope)
