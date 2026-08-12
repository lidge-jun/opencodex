# Phase 4 — allocator residual after the bounded macOS relay

**Status:** implementation design; do not claim that this phase has reduced RSS.

Phase 3 must be measured first.  Its removal of the `tee()` amplifier is necessary,
but it cannot be called a complete memory fix: the isolated HTTP/single-reader runs
already retained **1.65–2.04 GiB** of RSS after `Bun.gc(true)` and a five-second
idle observation, with only 10–22 MiB of `external` at peak
([`000_plan.md:58-79`](./000_plan.md#L58-L79)).  The most likely honest terminal
result is therefore **NOOP-with-documentation**, not a speculative allocator knob.

## Current upstream position (rechecked 2026-07-31)

The upstream statuses supplied to this unit are unchanged:

- [Bun #21560](https://github.com/oven-sh/bun/issues/21560) remains **open**.  Its
  report includes macOS M1, flat heap/external, increasing RSS, and no immediate
  RSS return after forced GC.
- [Bun PR #30590](https://github.com/oven-sh/bun/pull/30590) remains **closed and
  unmerged** (closed 2026-06-26).  Its diagnosis is directly relevant: finalizers
  free ArrayBuffer/string pages into libpas caches and Bun-owned bytes into
  mimalloc per-thread heaps; without scavenging/purge, that is allocator retention,
  not proof of a live JS object leak.  It also explicitly made its RSS assertion
  Linux-only because macOS reclaim is lazy.
- [Bun PR #28743](https://github.com/oven-sh/bun/pull/28743) is **closed unmerged**.  It
  is the closest ownership path: fetch response bytes allocated on an HTTP thread
  can be freed after GC on a different thread and remain in mimalloc delayed/free
  caches.  It says macOS RSS is the wrong immediate pass/fail signal because
  `MADV_FREE_REUSABLE` leaves pages resident until kernel pressure.
- [Bun.gc](https://bun.com/reference/bun/gc) documents that `Bun.gc(true)` runs a
  synchronous JavaScriptCore GC and asks mimalloc to clean fragmented memory.  It
  does **not** promise that macOS RSS falls.

These sources explain a residual; they do not prove the byte split for this process.
That requires the experiment below.

## 1. Attribution experiment

### Question and limits

The result must be a range and a residual, not a made-up percentage.  On a given
sample, calculate only these defensible quantities:

| Quantity | Measurement | What it proves | What it cannot prove |
|---|---|---|---|
| JS heap context | `jscHeap.heapSize`, `heapCapacity`, `objectCount` plus `heapUsed` | A growing JSC heap/object population is evidence to investigate live JS retention. | It is not a full JSC/native allocation total and cannot assign the rest of RSS to mimalloc. |
| JS-tracked native pressure | `external` and `arrayBuffers` | Bytes Bun exposes as external/ArrayBuffer accounting; a spike here bounds an active tracked allocation. | `external` is neither total native memory nor a source label (HTTP client versus server). It may fall while retained pages stay resident. |
| Proxy continuation state | `responseState.totalBytes`, entries, largest entry, oldest age | A growing continuation store is an owned, proxy-level candidate. | It does not account for stream chunks, HTTP buffers, JSC, or allocator caches. |
| Resident / physical footprint | `process.memoryUsage().rss`; `ps -o rss= -p $pid`; `footprint -p $pid`; `vmmap -summary $pid` | The process has retained resident/physical pages; `vmmap` supplies VM-region evidence such as MALLOC and mapped regions. | macOS VM regions do not reliably label pages as libpas versus mimalloc, nor fetch-client versus response-server buffers. |
| Unattributed native residual | `rss - jscHeap.heapSize - external` (reported only as a **non-additive diagnostic residual**) | A large, stable value after objects and external accounting fall is compatible with allocator retention. | It must never be presented as an exact allocator byte count: these counters overlap and use different accounting boundaries. |

`GET /api/system/memory` already returns `jscHeap` by importing `bun:jsc` and
calling `heapStats()` at
[`src/server/management/system-routes.ts:34-47`](../../../src/server/management/system-routes.ts#L34-L47),
then returns it alongside `rss`, `heapUsed`, `external`, `arrayBuffers`,
`responseState`, and the watchdog samples at
[`src/server/management/system-routes.ts:67-86`](../../../src/server/management/system-routes.ts#L67-L86).
It is useful context, not an allocator attribution API.  In particular, a flat
`jscHeap` with rising RSS excludes neither a live native object nor a retained
allocator page.

### Reproducible matrix

#### Harness contract for cells D/E/F (closes audit blocker 4)

Phase 1 implements only the proxy topology (cell B). Cells D/E/F must measure a
process with NO proxy code in it, so "extend the harness" is not a sufficient
instruction — mixing roles into one process would contaminate exactly the
attribution this phase exists to produce.

Shape: ONE controller CLI, but every measured role runs as its own spawned child.
"One binary" means one orchestrator, not one measured process.

| File | Role |
|---|---|
| `scripts/macos-rss-retention-harness.ts` | Controller. Parses `--cell A..F`, creates the run directory, spawns and stops role children, collates JSONL, invokes `ps` / `vmmap` / `footprint`. Orchestration only — never hosts a measured workload. |
| `scripts/macos-rss-retention-harness-child.ts` | The proxy child from Phase 1, unchanged. Used by cells A-C and F. |
| `scripts/macos-rss-retention-harness-worker.ts` | Role process selected by `--role`: `fixture-upstream`, `load-client`, `standalone-fetch-client` (cell D), `standalone-response-server` (cell E). |
| `scripts/macos-rss-retention-harness-metrics.ts` | Shared sampler and record schema: `process.memoryUsage()`, `heapStats`, lifecycle markers, JSONL/IPC emission. Imported by every measured child so all cells emit directly comparable records. |

Invariants that make the matrix trustworthy:

- Each cell starts FRESH processes; no cell reuses a process from another cell,
  because high-water-mark behavior makes a reused process carry prior peaks.
- `vmmap` and `footprint` capture is MANDATORY per cell, not optional — RSS alone
  cannot separate resident-but-reusable pages from live allocation.
- The controller writes one machine-readable comparison artifact per run so cells
  are diffed by tooling rather than by eye.
- Cells D and E must contain no import path that reaches `src/server/`. State this
  as a checked property, not an intention.

Extend the Phase-1 harness; do not infer this from the production watchdog's
60-second cadence (`DEFAULT_INTERVAL_MS` at
[`src/server/memory-watchdog.ts:53-56`](../../../src/server/memory-watchdog.ts#L53-L56)).
For each cell, run three fresh-process repetitions on macOS arm64/Bun 1.3.14,
use Phase 3's selected relay, and sample every 250 ms during load and for 60
seconds after all streams finish.  Record the process PID, `Bun.version`, Bun
revision, workload bytes, concurrency, client read rate, `process.memoryUsage()`,
`heapStats()`, `/api/system/memory`, and `ps` RSS.  Capture `vmmap -summary $pid`
and `footprint -p $pid` at: warmed idle, peak, immediately after `Bun.gc(true)`,
5 seconds idle, and 60 seconds idle.  Store scalar series and tool text as harness
artifacts; never record request bodies.

| Cell | Topology / control | Attribution it adds |
|---|---|---|
| A | Start the proxy, warm management routes, then idle. | Process/runtime baseline and the cost of diagnostics. |
| B | Phase-1 fake SSE upstream → proxy → **fast** HTTP clients. | Normal proxy client+server path without deliberate downstream pressure. |
| C | Same B workload, but slow clients. | Extra native retention associated with the proxy's response-server/downstream path after Phase 3 removes tee. |
| D | Fake upstream → a standalone Bun client that drains and discards each body; no proxy. | Bun HTTP-client/fetch baseline under the same upstream chunking. |
| E | A standalone Bun server sends the same bytes to the same fast/slow clients; no proxy fetch. | Bun HTTP response-server baseline under the same downstream pacing. |
| F | Proxy B with a client abort at a fixed byte offset, compared with a completed client. | Whether abort/ownership transfer changes the retained plateau; this is the closest observable analogue to #28743. |

Keep each process role separate.  The difference **B − A** is a proxy-topology
delta, **D − idle-client** bounds the standalone fetch/client contribution, and
**E − idle-server** bounds the standalone server contribution.  **C − B** is
downstream pacing sensitivity.  These are comparisons, not additive buckets:
the separate processes have different allocators, threads, and lifetime timing.

The only legitimate labels are:

1. `JSC-associated`: heap/object counters remain elevated through the 60-second
   idle period and a heap snapshot/retainer investigation finds a live owner.
2. `tracked-external-associated`: external/ArrayBuffer remains elevated and the
   isolated cell identifies the responsible topology.
3. `HTTP-topology-associated`: a reproducible B/C/D/E/F delta, with the exact
   topology named; it is still not a byte-level client/server split.
4. `unattributed native/allocator-compatible`: RSS/physical footprint remains
   while JSC, external/ArrayBuffer, response state, open requests, and the phase-2
   queue metrics have returned to baseline.  This is the expected residual.

If a source-level answer is needed after that, run one *diagnostic-only* repeat
with Xcode Instruments Allocations or `MallocStackLogging`/`malloc_history` and
state that it changes allocator behavior and cannot be used for the performance
number.  `vmmap` and `footprint` corroborate pages/footprint, but cannot establish
libpas versus mimalloc ownership.  That final separation requires Bun allocator
instrumentation or an upstream runtime build, and is therefore an upstream block,
not a proxy code task.

## 2. `Bun.gc(true)`: no production call in this phase

Do **not** add an idle-triggered or threshold-triggered `Bun.gc(true)` call.  It
is synchronous (so it adds a stop-the-world CPU/latency cost), and the local
three-run result already shows external accounting released but no RSS return in
five seconds ([`000_plan.md:70-79`](./000_plan.md#L70-L79)).  A flat high-water
plateau is not an actionable leak signal, so periodic GC would spend CPU without
an observed operator benefit.

The only permitted use is inside the harness: once after every load cell, outside
the request-latency measurement, followed by the 5s and 60s samples.  Report GC
wall-clock time and the change in all counters; never hide it as a normal request
or watchdog action.

Reconsider a production, idle-only GC hook only if a supported Bun release on
macOS demonstrates all of the following in three fresh-process runs:

- at least 50% of the post-load RSS growth is gone by 60 seconds after one GC,
- the reduction repeats under B, C, and F rather than only a synthetic allocation
  loop,
- no request is active, the CPU/stop time is measured and acceptable, and tail
  latency is unchanged in a concurrent control run,
- the release notes/API documentation support that behavior on macOS.

Until then, a manual process drain/restart remains an explicitly labelled operator
escape hatch, not a memory fix (the restart endpoint is already separate at
[`src/server/management/system-routes.ts:90-101`](../../../src/server/management/system-routes.ts#L90-L101)).

## 3. Undocumented mimalloc environment knobs

[mimalloc's environment documentation](https://microsoft.github.io/mimalloc/environment.html)
defines `MIMALLOC_PURGE_DELAY=N` (default 1000 ms; `0` trades performance for
immediate purging) and `MIMALLOC_PURGE_DECOMMITS=1` (decommit rather than reset).
They are **not documented Bun runtime configuration**, so neither is a supported
OpenCodex setting.  Shipping either as a default is out of scope.

One bounded launch-time experiment is worthwhile because it can close the question:

| Variant | Environment before process start | Repetitions |
|---|---|---|
| Control | neither variable | 3 |
| Delay | `MIMALLOC_PURGE_DELAY=0` | 3 |
| Decommit | `MIMALLOC_PURGE_DECOMMITS=1` | 3 |
| Both | both variables | 3 |

Run cells B, C, and F only, with identical workload and a fresh process for every
run.  Capture the attribution series, `vmmap`/`footprint`, post-load RSS at 5s and
60s, total throughput, p50/p95/p99 inter-chunk latency, CPU time, and crash/error
rate.  A variant is a candidate only if it lowers the median 60-second residual by
at least 50% in every topology with no >5% throughput regression, no >10% p99
inter-chunk regression, and no new failures.  Otherwise record it as rejected.

Even a pass is not a default.  It would justify a separate, documented,
**launch-time opt-in escape hatch** that states the Bun support boundary and exact
tested version/platform.  It must be absent from generated service defaults, config
schema defaults, and normal user guidance until Bun documents support or the team
explicitly accepts ownership of the compatibility risk.

## 4. Other buffering sites: exclude what is not streaming

| Site | Current behavior | Plausible contributor to concurrent SSE streaming? | Phase-4 action |
|---|---|---|---|
| [`src/server/images.ts:443-454`](../../../src/server/images.ts#L443-L454) | `arrayBuffer()` completes before the response-size check; the payload is then copied into the downstream `Response`. | **No** for the target workload: this is a paid image JSON/base64 request, not the Responses SSE relay. It can cause a separate large allocation on concurrent image traffic and the cap is post-buffer. | Exclude from the streaming residual experiment. Track separately as a correctness/memory-hardening candidate: reject oversized `Content-Length` first and stream with a byte cap. Do not claim it explains B/C/F. |
| [`src/adapters/google.ts:595-631`](../../../src/adapters/google.ts#L595-L631) | The adapter reads a bounded non-streaming response into chunks, concatenates a `Uint8Array`, decodes to text, then parses JSON. | **No** for the target SSE path. It is bounded by `MAX_RESPONSE_BYTES`, but has intentional transient copies for a Google JSON response. | Exclude from this phase's streaming RSS number. Any copy reduction needs a Google-adapter-specific profile and regression test. |
| [`src/server/search.ts:98-117`](../../../src/server/search.ts#L98-L117) | `arrayBuffer()` consumes the complete search JSON response before its post-read cap and downstream response. | **No** for the target SSE workload: `/alpha/search` is a request/response sidecar, not the streaming relay. It can independently create a high-water plateau during large search traffic. | Exclude from B/C/F. Follow up as a separate capped-streaming/Content-Length hardening task if search traffic demonstrates it. |

This phase must not pad the result with unrelated allocations.  The experiments
may add an explicit non-streaming stress control for images/search only to prove
that distinction, but its number must not be merged into the SSE residual.

## 5. Watchdog: warn on sustained rate, keep level only as a safety ceiling

The existing watchdog samples one scalar every 60 seconds and warns when the
largest of RSS/external/ArrayBuffers crosses a flat 4 GiB threshold
([`src/server/memory-watchdog.ts:31-45`](../../../src/server/memory-watchdog.ts#L31-L45),
[`src/server/memory-watchdog.ts:123-139`](../../../src/server/memory-watchdog.ts#L123-L139)).
Audit blocker 5 corrected an earlier misreading here and the rationale is amended
accordingly. The current warning is NOT continuously noisy: `WARN_INTERVAL_MS`
rate-limits it to once per 30 minutes
([`src/server/memory-watchdog.ts:134-139`](../../../src/server/memory-watchdog.ts#L134-L139)).
The real defect is different and narrower — the signal is **level-only**, so it
cannot distinguish a process sitting at a harmless high-water plateau from one
that is still climbing. Given that E3 proved plateau behavior is expected on this
runtime, level alone is the wrong verdict input. Make **sustained RSS growth rate**
the primary warning and retain 4 GiB as a separately rate-limited safety ceiling
that reports a ceiling, not a leak.

Tests must encode that corrected distinction: a stable ceiling still emits its
rate-limited safety warning (unchanged behavior), while sustained growth emits the
new growth reason. A test that merely asserts "no warning at plateau" would encode
the misreading rather than the fix.

Proposed diff contract (constants are deliberately conservative until Phase-1
series calibrates them):

```ts
export type MemoryGrowth = {
  deltaBytes: number;
  windowMs: number;
  bytesPerMinute: number;
};

const DEFAULT_GROWTH_WINDOW_SAMPLES = 5; // 5 min at the current 60 s cadence
const DEFAULT_RSS_GROWTH_BYTES_PER_MINUTE = 32 * 1024 ** 2;
const DEFAULT_MIN_RSS_FOR_GROWTH_WARNING = 512 * 1024 ** 2;

export function rssGrowth(samples: readonly MemorySample[]): MemoryGrowth | null {
  if (samples.length < DEFAULT_GROWTH_WINDOW_SAMPLES) return null;
  const first = samples.at(-DEFAULT_GROWTH_WINDOW_SAMPLES)!;
  const last = samples.at(-1)!;
  const windowMs = last.at - first.at;
  if (windowMs <= 0) return null;
  const deltaBytes = last.rss - first.rss;
  return { deltaBytes, windowMs, bytesPerMinute: deltaBytes * 60_000 / windowMs };
}
```

```ts
const growth = rssGrowth(samples);
const growsSustainably = growth !== null
  && s.rss >= DEFAULT_MIN_RSS_FOR_GROWTH_WARNING
  && growth.bytesPerMinute >= DEFAULT_RSS_GROWTH_BYTES_PER_MINUTE;
const exceedsSafetyCeiling = s.rss >= warnThresholdBytes;

if ((growsSustainably || exceedsSafetyCeiling) && canWarn(now())) {
  lastWarnAt = now();
  const reason = growsSustainably
    ? `RSS grew ${Math.round(growth.bytesPerMinute / 1024 ** 2)}MB/min over ${Math.round(growth.windowMs / 60_000)}m`
    : `RSS is ${Math.round(s.rss / 1024 ** 2)}MB (safety ceiling)`;
  warn(`⚠️  opencodex memory watch: ${reason}. See ${DOCS_URL}`);
}
```

The implementation must add `lastGrowth`, `lastGrowthWarnAt`, and an explicit
warning reason to `MemoryWatchdogState`, then expose those scalar fields through
the existing `/api/system/memory` snapshot path
([`src/server/management/system-routes.ts:54-64`](../../../src/server/management/system-routes.ts#L54-L64)).
Tests must cover: stable 2 GiB after a spike does not rate-warn; five increasing
samples do; a 4 GiB stable process gets only the safety warning; ring truncation,
non-monotonic timestamps, and injected sample errors remain safe.  Update the
current Windows-only wording/URL at
[`src/server/memory-watchdog.ts:57`](../../../src/server/memory-watchdog.ts#L57)
only together with the user-facing macOS documentation below.

## 6. Terminal outcomes and required evidence

| Verdict | Meaning | Required evidence |
|---|---|---|
| **DONE — local reduction** | A supported, proxy-owned allocation is reduced without changing semantics. | Three-run Phase-3-vs-control attribution series; >50% median 60-second residual reduction in the relevant B/C/F topology; matching correctness/load tests; no regression in throughput/tail latency; before/after `vmmap`/`footprint`; user docs and a closed `_fin` record. |
| **DONE — watchdog observability** | No allocator bytes are reclaimed, but the warning becomes a truthful growth signal. | Deterministic watchdog unit tests for the contract above; recorded high-water trace showing level-only false alarm suppressed and sustained growth detected; user docs explaining that a plateau is not a leak verdict. This is not called an RSS fix. |
| **NOOP-with-documentation** | The residual is allocator-compatible and no supported local intervention reduces it. | A–F matrix for three fresh-process runs; flat post-load JSC/external/response state and Phase-2 queue metrics; repeatable plateau rather than compounding equal spikes; `vmmap`/`footprint` evidence; `Bun.gc(true)` no material 60-second reduction; current upstream-status check. |
| **BLOCKED-on-upstream** | The matrix isolates a runtime client/server/ownership residual but cannot divide/return it with supported Bun APIs. | The NOOP evidence plus a named topology (especially F) and upstream references #21560/#28743; a minimal sanitized reproducer and data attached to or cross-linked from an upstream Bun issue; exact Bun version/revision. No claim that an unmerged PR is shipped. |

## 7. Documentation written regardless of verdict

Ship the user-facing note in the canonical docs site, not only in `structure/` or
devlog.  Add `docs-site/src/content/docs/troubleshooting/macos-memory.md` and a
`MacOS Memory Retention` sidebar item next to the existing Windows page in
[`docs-site/astro.config.mjs:125`](../../../docs-site/astro.config.mjs#L125).
The existing Windows page is the closest style/reference
([`docs-site/src/content/docs/troubleshooting/windows-memory.md:6-70`](../../../docs-site/src/content/docs/troubleshooting/windows-memory.md#L6-L70)),
but must not be copied as a platform claim.

The macOS page must say plainly:

1. bounded single-reader streaming removes the proxy's `tee()` amplification;
2. Bun 1.3.14/macOS can retain RSS after transient allocations even after GC;
3. stable JS heap/external plus a stable RSS plateau is allocator-compatible, not
   proof that OpenCodex is retaining request data;
4. the watchdog reports sustained growth and a safety ceiling, and never restarts
   automatically; and
5. users should capture `/api/system/memory`, Bun version/revision, workload shape,
   and a before/after plateau for an issue report—never API keys or request bodies.

Regardless of whether the code result is a local reduction, NOOP, or upstream
block, close the work with `devlog/_fin/260731_macos_rss_retention/040_allocator_residual.md`.
That record must include the terminal verdict, exact harness artifacts, current
upstream states, and links to the public docs.  `structure/` may link to the
canonical guide, but it is not the user-facing location.
