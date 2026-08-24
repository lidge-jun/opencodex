# 010 — Memory diagnostics: extraMemorySize in samples and API

Depends on: 000. Standalone PR (parent of the stack, targets dev).

## Why

Bun 1.4's biggest memory changes are external-memory reporting fixes
(#31422/#32653/#34142 per 260813 canary table). The counter that reflects them is
`heapStats().extraMemorySize` — JSC-visible native memory. Today
/api/system/memory reports jscHeap {heapSize, heapCapacity, objectCount} but NOT
extraMemorySize, and watchdog samples carry no JSC counters at all, so the exact
signal 1.4 improved is invisible in our 6h ring.

## Changes

### src/server/management/system-routes.ts
jscHeap block gains one field:
```diff
       jscHeap = {
         heapSize: stats.heapSize,
         heapCapacity: stats.heapCapacity,
         objectCount: stats.objectCount,
+        ...(typeof stats.extraMemorySize === "number" ? { extraMemorySize: stats.extraMemorySize } : {}),
       };
```

**Unavailable is not zero.** An older Bun, or any runtime whose `heapStats()`
omits `extraMemorySize`, has not measured zero native memory — it has measured
nothing. Coercing that to `0` would put a fabricated sample into a series whose
entire purpose is to show whether native memory grows, and it would disagree with
the watchdog and doctor layers, which both type the field as optional. Omit the
key instead, and let every consumer distinguish absent from zero.
Type of local `jscHeap` widens accordingly.

### src/server/memory-watchdog.ts — SYNC-SAFE seam (audit finding 4)

defaultSample() is synchronous and MUST stay synchronous. Dynamic import is
async, so the seam is a STATIC import: this repository is Bun-native (AGENTS.md
runtime constraint — the proxy and `bun test` always run under Bun), so
`import { heapStats } from "bun:jsc"` at module top is justified; tsc strict
passes with the pinned Bun 1.4 types. The CALL is still guarded:

```diff
+import { heapStats } from "bun:jsc";
 ...
 export type MemorySampleBase = {
   ...
   arrayBuffers: number;
+  /** JSC heapStats().heapSize, when introspection is available. */
+  jscHeapSize?: number;
+  /** JSC heapStats().extraMemorySize — JSC-visible native memory. */
+  jscExtraMemorySize?: number;
 };
 ...
 function defaultSample(now: () => number): MemorySample {
   const usage = process.memoryUsage();
+  let jscHeapSize: number | undefined;
+  let jscExtraMemorySize: number | undefined;
+  try {
+    const stats = heapStats();
+    jscHeapSize = stats.heapSize;
+    jscExtraMemorySize = stats.extraMemorySize;
+  } catch { /* introspection failure must never break sampling */ }
   const base = { ..., jscHeapSize, jscExtraMemorySize };
```
observedMemoryCounter() UNCHANGED — thresholding remains rss/external/
arrayBuffers. Observability only, no behavior change. Injected `opts.sample`
seam already lets tests supply samples without bun:jsc.

### src/cli/doctor.ts
Service memory line appends `jscExtra=…` when the API returns
`body.jscHeap.extraMemorySize`. jsShare heuristic unchanged.

## Tests
tests/memory-watchdog.test.ts: injected sample with jsc fields round-trips
through snapshot(); default sampler under bun test records numeric jsc fields.
system-routes test: /api/system/memory exposes jscHeap.extraMemorySize.

## Measurement claim
None (diagnostics only) → goalplan c3 rationale: config/diagnostic-only.
