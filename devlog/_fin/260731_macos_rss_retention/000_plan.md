# macOS RSS retention under concurrent SSE streaming

Unit opened 2026-07-31. Work lands directly on `dev`. Parallel experiments run in
separate git worktrees driven by subagents — no side branch for this unit.

## Symptom

A long-lived proxy on macOS arm64 (Bun 1.3.14) climbs monotonically in RSS under
concurrent agentic streaming and never returns memory to the OS. Measured on the
live process (pid 63737, `/api/system/memory` watchdog ring, 60s cadence):

| Time | RSS | external | heapUsed |
|---|---|---|---|
| 23:08:55 | 1.67 GiB | 35.8 MiB | 50.7 MiB |
| 23:17:57 | 3.30 GiB | 1104.6 MiB | 1410.4 MiB |
| 23:23:58 | 3.87 GiB | 1571.0 MiB | 1974.4 MiB |
| 23:27:58 | 4.62 GiB | 157.3 MiB | 175.1 MiB |

The last row is the diagnostic one: `external` fell to a tenth of its peak while
RSS stayed pinned at 4.62 GiB. `external` oscillates; RSS only ratchets upward,
tracking the high-water mark of the spikes.

The continuation store is not the cause — it held 85 entries / 48 MB at the time
of the 4.62 GiB sample, under 1% of resident memory.

## Constraint

Process restart is REJECTED as the solution. The existing drain-and-restart
action stays as an operator escape hatch and must never be reported as the fix.

## Evidence

### E1 — upstream status (external research, Tier-2 proven)

- `ReadableStream.tee()` slow-branch accumulation is a standards-level hazard:
  [whatwg/streams#1235](https://github.com/whatwg/streams/issues/1235), open.
  Chunks accumulate in the lagging branch without upstream backpressure.
- Bun tracks RSS retention separately from JS leaks:
  [oven-sh/bun#21560](https://github.com/oven-sh/bun/issues/21560), open, includes
  macOS Apple Silicon, reports stable heap with rising RSS that does not fall after GC.
- Diagnosis of that pattern: [oven-sh/bun#30590](https://github.com/oven-sh/bun/pull/30590)
  (closed unmerged 2026-06-26) attributes it to freed pages retained in libpas
  caches and mimalloc per-thread heaps — allocator retention, not a live-object leak.
- Closer to the fetch path: [oven-sh/bun#28743](https://github.com/oven-sh/bun/pull/28743),
  **closed unmerged** — HTTP-thread allocations freed on the JS thread land in a
  delayed-free list. Historical diagnosis only; it is not an active upstream fix
  path and must not be cited as one.
- No Bun-specific `tee()` retention issue or fix exists. Do not conflate #1235 with one.

### E2 — two corrections to earlier assumptions

1. **A Bun version bump is not available.** [PR #32120](https://github.com/oven-sh/bun/pull/32120)
   merged 2026-06-21 but ships in no stable release. Latest stable is v1.3.14
   (2026-05-13), which the repository already bundles. Adopting a canary as the
   default runtime was rejected by the user and is moot regardless.
2. **#32120 is not Windows-only, and #32111 is closed rather than open.**
   [#32111](https://github.com/oven-sh/bun/issues/32111) was CLOSED by merged
   #32120. The precise status is "fixed upstream, present in no stable release" —
   not "open defect". It still reproduces on Darwin arm64 under Bun 1.3.14, which
   is the bundled runtime, so the crash risk is live for us even though the issue
   is closed. It is an async-stream client-abort crash, not a retention defect, so
   it does not explain the RSS symptom either way; it constrains Phase 3's gate.

### E3 — isolated reproduction (Bun 1.3.14, macOS arm64, 3 runs each)

Scripts under `/tmp/bun-tee-isolation.iJNNpB`. 64 KiB chunks; in-process runs
stream 4000 chunks (250 MiB); the HTTP run uses 4 concurrent slow clients.

| Experiment | peak external | peak RSS | RSS after GC + 5s |
|---|---|---|---|
| EXP-1 tee, lagging branch | 249.8 MiB | 292.7 MiB | 292.7 MiB |
| EXP-2 single reader | 4.1 MiB | 46.0 MiB | 46.0 MiB |
| EXP-3 HTTP, tee | 363–461 MiB | 2312–3031 MiB | unchanged |
| EXP-3 HTTP, single reader | 10–22 MiB | 1655–2044 MiB | unchanged |

Findings:

- Rate-mismatched `tee()` amplifies `external` by ~60x in-process and ~30x over HTTP.
- `Bun.gc(true)` releases the `external` accounting but RSS does not come back
  within the observation window.
- Repeated equal-size spikes settle at the first peak rather than compounding —
  high-water-mark behavior, consistent with allocator retention.
- **Counter-evidence that must not be lost:** removing tee still leaves 1.65–2.04 GiB
  pinned RSS in the HTTP topology. `tee()` is the dominant amplifier, NOT the sole
  cause. Bun's HTTP buffering and allocator behavior are also material.

### E4 — what the macOS code path actually does

macOS carries a double cost, which is worse than the original hypothesis assumed.

- `src/server/responses/core.ts:1686` tees every passthrough SSE body.
- `src/server/responses/core.ts:1749` — the client branch is ALSO wrapped in the JS
  relay `relaySseWithFailedTail`. The native handoff is gated to
  `process.platform === "win32"`, so macOS never gets it.
- The inspection branch has no bound:
  - `src/server/relay.ts:505` — `buffer` accumulates incomplete SSE frames uncapped.
  - `src/server/relay.ts:485` — `completedItemsByOutputIndex` retains completed output
    items and is not cleared after the completed-response callback.
  - `JSON.parse` runs twice per event (request-log metadata + continuation capture),
    plus regex framing and `split` per chunk. This is what makes the branch lag.
- On client disconnect the inspection reader is not explicitly cancelled; it settles
  only indirectly once `upstream.abort()` errors the stream.

Crucially, `relaySseEagerBounded` (`src/server/relay-eager.ts`) already receives the
same inspector hooks — terminal outcome, log metadata, continuation capture,
first-output timing — and pauses its producer at an 8 MiB queue bound. **No
inspection feature depends on the second tee branch.** macOS is excluded by the
platform gate at `core.ts:1626`, not by a capability gap.

What the eager path does NOT do today: client-facing image-gen alias restoration,
Responses item-ID repair, and the synthetic `response.failed` tail on mid-stream
reset (it errors the client stream instead).

### E5 — instrumentation inventory

Reusable: `startServer(0)` (`src/server/index.ts:253`), the watchdog sampler, the
authenticated `GET /api/system/memory`, `ocx observe memory --json`, and the
offline fake-upstream pattern (local `Bun.serve` + provider `baseUrl` +
`allowPrivateNetwork`, as in `tests/claude-messages-endpoint.test.ts:68`).

Must be built: a load harness, a configurable fake SSE upstream, concurrent-client
orchestration, and sub-second sampling. The watchdog samples at 60s
(`src/server/memory-watchdog.ts:53`), far too coarse to see the spikes.

## Work-phase map (dependency-ordered)

Each phase closes with something independently verifiable.

| Phase | Doc | Outcome |
|---|---|---|
| 1 | `010_measurement_harness.md` | Reproducible harness + captured baseline series |
| 2 | `020_inspection_bounds.md` | Bound the inspection branch; measure the delta |
| 3 | `030_macos_single_reader.md` | Let macOS select the bounded single-reader path without losing rewrite/failed-tail behavior |
| 4 | `040_allocator_residual.md` | Address or document the non-tee residual RSS |

Ordering rationale: nothing can be judged before the harness exists (phase 1).
Bounding the inspector (phase 2) is a local, low-risk change that attacks the
proven lag mechanism and must be measured on its own before the larger path
change. The single-reader migration (phase 3) is the structural fix and depends
on phase 2's measurements to size its benefit. The allocator residual (phase 4)
is last because E3 shows it is independent of our stream shape — it may end in a
documented NOOP with upstream references rather than a code change.

## Scope boundary

IN: `src/server/responses/core.ts`, `src/server/relay.ts`,
`src/server/relay-eager.ts`, `src/lib/bun-stream-caps.ts`, `src/config.ts`
(streamMode surface), `src/server/memory-watchdog.ts`, `tests/`, and this unit.

OUT: rewriting the runtime in another language; adopting a Bun prerelease as the
default; provider adapters, routing, auth, GUI. The dirty worktree files owned by
a concurrent task (subagents-workspace, `Subagents.tsx`, subagent i18n keys, `go/`)
are not to be touched.

## Open questions carried into phase 1

- How much of the live 4.62 GiB is tee amplification versus the HTTP/allocator
  residual that EXP-3 exposed? The harness must be able to attribute this.
- Does the inspection branch actually lag in production traffic, or only under the
  synthetic pacing used in EXP-1? Instrumentation must record real lag, not assume it.
