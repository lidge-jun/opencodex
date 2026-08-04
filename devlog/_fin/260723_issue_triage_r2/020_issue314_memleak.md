# 020 — Issue #314: RAM leak (Windows 11, v2.7.31)

## Report

- Author: BuSung-dev, 2026-07-23. Codex CLI, Windows 11, ocx 2.7.31.
- Evidence: Task Manager screenshot — single **Bun** process at **23,419 MB RSS** (89% memory),
  CPU 2.1%, network 2.2Mbps still active. "조금 쓰다보면" (grows with normal use).
- No logs, no provider/model info, no config. Only the screenshot.

## App-side audit (dev @ af973e54)

Checked every long-lived in-process store for unbounded growth:

| Store | File | Bound |
|---|---|---|
| requestLog ring | src/server/request-log.ts:109,200 | MAX_LOG_SIZE=200, shift() on overflow |
| usage debug lines | src/usage/debug.ts:14,52 | 200 lines |
| responses state | src/responses/state.ts:7,136 | 1h TTL + pruneResponses() on every access; snapshot capped 2MiB/entry, 24MiB total |
| usage.jsonl reads | src/usage/log.ts:312 | readRecentUsageEntries windowed read (no full-file load on start) |
| module-level Maps/Sets | config/catalog/oauth/etc | warn-dedupe sets, static allowlists — bounded by config size |

SSE relay paths (src/server/relay.ts) use pull-based ReadableStream passthrough with
abort-on-cancel; no TransformStream piping, no full-body accumulation on the hot path.
GUI polls /api/usage (readUsageEntries full-file parse, management-api.ts:469) per
request but the result is not retained → GC-able; contributes CPU/alloc churn, not
a 23GB retained set.

**Verdict: no plausible app-side unbounded structure that reaches 23GB.**

## Bun-runtime evidence (Windows)

opencodex pins **Bun 1.3.14** (package.json engines + all CI workflows).

Known upstream Bun issues that match this profile:

- oven-sh/bun#28035 — `fetch().body` piped through streams fails to propagate
  backpressure; proxy repro reached **13.5 GB RSS** while client consumed 1 MB/s.
  This is exactly our shape: long-lived localhost streaming proxy.
- oven-sh/bun#26321 — Windows `Bun.file().stream()` RSS growth (closed as dup of
  #17228); JS heap flat while native RSS grows → native buffering, not JS GC.
- oven-sh/bun#18488 — fetch-streaming leak ≥1.1.27, closed 2026-01-13.
- Bun v1.3.12 fixed a `Bun.serve()` leak when a fetch handler's Promise never
  settles after client disconnect (we are past that, but it shows this class of
  bug is recurring in Bun's Windows/HTTP paths).
- Bun v1.4.0 shipped broad native memory-leak fixes (repeated-work RSS
  6.7 GB → 609 MB vs 1.3.14 in Bun's own numbers).
- **oven-sh/bun#32585** — pre-existing report *from an opencodex user*: Bun 1.3.14
  segfaults in a long-running opencodex localhost proxy on Windows 11; reporter's
  workaround was switching to canary Bun 1.4.0 and the proxy stabilized. Open,
  filed 2026-06-22. This independently corroborates 1.3.14-on-Windows runtime
  instability under our exact workload.

## Classification

Bucket C-leaning (upstream Bun runtime on Windows), with an actionable mitigation
lane on our side:

1. **Needs-info from reporter**: `process.memoryUsage()` rss vs heapUsed over time
   (flat heapUsed + rising RSS ⇒ native leak, confirms Bun-side), provider/model in
   use, whether streaming-heavy sessions correlate.
2. **Actionable mitigation**: evaluate bumping pinned Bun 1.3.14 once Bun 1.4
   reaches a STABLE release (as of 2026-07-23, stable latest is still 1.3.14;
   1.4.0 exists only on the canary channel — `bun upgrade --canary`). #32585's
   reporter validated a 1.4.0 canary stabilizing the same proxy. Bump requires
   full CI on all three OSes + release-train discipline; Bun pin change touches
   release automation ⇒ security-review lane per MAINTAINERS.md.
   Follow-up comment correcting the upgrade guidance:
   issue #314 comment 5055562903 (2026-07-23).
3. Optional diagnostics: a lightweight `/api/debug/memory` (rss/heapUsed/external)
   would let Windows reporters self-serve the native-vs-JS discrimination.

No code changes in this unit; investigation only.
