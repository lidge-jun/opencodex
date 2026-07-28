# 052 — Phase 5b: Pull-driven backpressure in bridge + chat outbound

One PABCD cycle. The restructure half of 050. Runs AFTER 051 (its queue
cap is the resource bound for slow clients; its abort guard covers the
lengthened fetch->first-pull window). The 050 overview's DECIDED
semantics are binding: upstream-silence-only stall clock, gated-state
rules, no internal FIFO, macrotask-yield removal, WP2 terminal ordering
preserved.

## Scope

IN:
- src/bridge.ts (bridgeToResponsesSSE: start->pull restructure)
- src/chat/outbound.ts (same discipline in the chat converter)
- tests: bridge-lifecycle, bridge-live-delivery, bridge-terminal-singleness,
  chat-completions-endpoint, new slow-consumer + gated-stall tests;
  Claude-outbound / WS first-frame verification

OUT: native passthrough relay (eager bounded relay exists; Windows tee =
class 10), run-turn-queue (051 landed), WS bridge internals.

## File change map

### 1. src/bridge.ts — pull-driven consumption

Current (verified): `async start(controller)` runs the whole manual-
iterator loop eagerly; `controller.enqueue` is unbounded; stall/heartbeat
interval lives in start; WP2 terminal ordering: onCancel -> break ->
void it.return?.()?.catch.

Change (mechanics, per DECIDED semantics):
- Move the adapter-event loop from start() into `pull(controller)`-driven
  stepping: each pull processes adapter events until at least one frame
  is enqueued (per-event atomicity: one adapter event's frames all land
  inside one pull — no internal FIFO, no split lifecycle pairs).
- start() keeps ONLY: `response.created` emission (first frame guarantee
  for eager readers), state init, and the stall/heartbeat interval.
- GATED FLAG MECHANICS (A-gate fold, binding): a `gated` boolean is set
  false when a pull starts stepping and true when the pull returns
  (initial value false; with the default queuingStrategy HWM=1 the first
  pull fires immediately after start()). The interval observes it: while
  `gated === true` it skips BOTH stall-tick advancement and downstream
  heartbeat enqueue. Only while `gated === false` does the stall clock
  advance — that is the upstream-silence-only semantics made observable.
- Emit is NOT gated (A-gate precision): gating applies ONLY to loop
  stepping. Synthesized terminal frames therefore need no "bypass
  allowance" — they emit through the normal ungated path; there is no
  allowance counter to build. (This supersedes the overview's "bounded
  allowance" phrasing; "pull drains gated terminal frames" is meaningless
  in this model and is dropped.)
- State hoisting (A-gate precision): the loop-local state (emit, emitDone,
  currentMsg/currentReasoning/..., finishedItems, closures) moves from the
  start() scope to the stream-factory function scope, with `controller`
  stored in a shared variable assigned by start(). No controller proxy.
- Criterion 1 precision: no custom queuingStrategy — the default HWM=1
  applies; an unpulled stream consumes at most the events needed to reach
  the first frame (a small constant) beyond start().
- Stall/heartbeat interval behavior while pull-gated: stall ticks do NOT
  advance (upstream-silence-only semantics — the loop is not consuming,
  so "no adapter event observed" is not upstream silence); downstream
  heartbeat frames are SKIPPED while gated (client behind; bounded by
  stall window). Synthesized terminal frames (stall incomplete, adapter
  error) BYPASS the gate with a bounded allowance, then
  controller.close() and onCancel.
- Terminal event inside a pull: process frames -> onCancel -> mark
  terminated -> fire-and-forget return.catch (WP2 order). After
  termination, pull drains any gated terminal frames then closes.
- REMOVE the macrotask-yield logic (bridge.ts:444-451): pull cadence is
  the natural delivery quantum. bridge-live-delivery.test.ts is the
  latency contract proving removal is safe.
- cancel(): onCancel + iterator return fire-and-forget + clear interval
  (existing behavior preserved).

### 2. src/chat/outbound.ts — same contract

The converter wraps a ReadableStream around the Responses SSE generator;
its `start(controller)` loop becomes pull-driven with the same per-event
atomicity (it sits downstream of the bridge, so with section 1 its queue
is the only remaining unbounded one). Its fail()/finish() paths are
unchanged; the EOF-truncation fail (:389) still fires from the loop's
natural end.

### 3. First-frame latency verification (from 050)

Verify Claude outbound (claude/outbound.ts:355) and the WS pump
(ws-bridge.ts:179) still observe first bytes without an extra event-loop
turn vs the eager baseline (bridge-live-delivery anchor; add a
first-frame assertion if missing).

## Accept criteria + activation scenarios

1. Slow-consumer: an unpulled bridge stream consumes no more than
   in-flight adapter events within a probe window (baseline probe
   consumed 77 events/100ms pre-change). Activation: scripted generator +
   never-read stream; assert consumption count.
2. Resume: reads drain FIFO and the event sequence matches an
   unconstrained run (ordering pin).
3. Gated stall: with a shortened stall budget, a never-read stream with a
   HEALTHY continuously-producing upstream does NOT synthesize
   upstream_stall_timeout while gated (false-stall semantics), and the
   queue cap (051) is the bound instead.
4. True stall while read: silent upstream -> stall incomplete synthesized,
   bypasses the gate, stream closes, onCancel fires.
5. Terminal ordering: error->done and done->trailing-error cases from
   bridge-terminal-singleness stay green (WP2 contract inside pulls).
6. Live-delivery: bridge-live-delivery green; Claude-outbound and WS
   first-frame checks pass.
7. Full gate: bun run typecheck + bridge/chat/passthrough suites green;
   full bun run test before push.

## Risks

- Hottest loop in the proxy: mitigated by WP1-WP4's pinned behavior tests
  plus the new ordering/latency gates.
- pull-driven changes cancellation timing: cancel-drain behavior pinned
  by bridge-lifecycle cancel tests must stay green.
