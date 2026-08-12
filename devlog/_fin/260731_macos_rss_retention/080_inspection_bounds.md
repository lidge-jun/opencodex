# Phase 080 — inspector bounds, clear points, disconnect cancel, parse-once, counters (wp3)

Design base: `051_inspection_branch_evidence.md` §Bounded-fix proposal. Targets
`src/server/relay.ts` (createSseInspector + consumers), `src/server/responses/core.ts`
(tee wiring), `src/server/memory-watchdog.ts` / `src/server/management/system-routes.ts`
(counter exposure). Client bytes are NEVER altered by this phase.

## 080.1 — frame cap (strict 4 MiB, raw-byte accounting)

In `createSseInspector` (`relay.ts:438`):

- Add module const `MAX_INSPECTION_SSE_FRAME_BYTES = 4 * 1024 * 1024` (4 MiB:
  covers realistic large agentic tool-call/terminal events — audit round 1
  blocker 4 — while still bounding runaway frames; see 061).
- Rewrite accumulation to the 051 raw-byte design (audit blocker 1): keep an
  array of RAW byte slices plus a byte count for the CURRENT un-delimited
  candidate only. Scan for the SSE blank-line delimiter incrementally across
  chunk boundaries at the byte level (ASCII `\n\n` / `\r\n\r\n`, carrying ≤3
  trailing bytes of delimiter state between chunks). When a delimiter is
  found, the completed candidate (≤ cap) is decoded ONCE and parsed; consumed
  bytes leave the charge immediately — a large consumed prefix never
  overcharges a small trailing partial frame.
- Overflow trips only when the CURRENT CANDIDATE (bytes since the last
  delimiter) crosses 4 MiB without a delimiter (R2-1): a chunk larger than
  4 MiB containing many small complete frames parses normally — the scanner
  consumes each delimited frame as it goes and only the un-delimited tail
  counts against the cap. On overflow: set `discardingOversizedFrame = true`,
  release all retained slices (charge = 0), increment `frameCapOverflows`,
  never decode the oversized candidate. While discarding, retain no payload
  bytes; scan delimiter state only. On the next complete delimiter, clear the
  flag and resume accumulation from the remainder.
- Delimiter parity (R2-1): the byte-level scanner accepts every form the
  current regex `/\r?\n\r?\n/` (relay.ts:91) accepts — `\n\n`, `\r\n\r\n`,
  `\r\n\n`, `\n\r\n` — including split across chunk boundaries.
- `finish()` must not parse a discarded candidate.
- Overflow degrades INSPECTION ONLY (terminal detection may miss an oversized
  terminal event → existing synthetic-incomplete path covers stream end; this
  misclassification is accepted, counted, and documented — client bytes and
  the client-visible terminal are unaffected).

## 080.2 — completed-items bounds

- `MAX_COMPLETED_OUTPUT_ITEMS = 256`, `MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES = 8 MiB`.
- Store `{ item, sourceBytes }` where `sourceBytes` = the SOURCE BYTE length
  (`byteLength` of the complete frame slice) that produced the item — not JS
  string length (audit blocker 2; bounded by the 4 MiB frame cap). Maintain
  `aggregateItemBytes`; on replace, subtract the old charge first.
- On insert exceeding either bound: evict highest indexes until both hold
  (lowest indexes are what completed-response reconstruction needs first);
  reject a single item whose own charge exceeds the aggregate cap. Increment
  `itemCapEvictions` per evicted/rejected item.
- **Taint on overflow (audit blocker 3):** any eviction or rejection sets
  `reconstructionTainted = true`. A tainted inspector NEVER synthesizes
  `output` from the partial map: `onCompletedResponse` fires with the
  response's own authoritative output when present, and does NOT fire at all
  when the terminal's output is empty/missing while tainted — so
  `rememberResponseState` (state.ts:429) can never store a truncated replay
  history.

## 080.3 — clear at ownership handoff/teardown

- Wrap `handlers.onCompletedResponse(response)` in `try/finally`; `finally`
  clears the map + aggregate charge.
- Clear immediately after a `response.failed`/`response.incomplete` terminal
  is reported (no completed reconstruction will consume the map).
- `finish()` clears frame + item state in `finally`.
- New `dispose()` on the `SseInspector` interface: drops buffer/map/charges
  without parsing. Called from `consumeForInspection` and
  `consumeForResponseLogMetadata` pump `finally` blocks, and from the eager
  producer `finally` in `relay-eager.ts`.

## 080.4 — parse-once

`scanPayload` currently triggers up to 5 `JSON.parse` calls per payload
(request-log metadata ×2 via `inspectResponseLogSsePayload`, first-output,
terminal detection, continuation capture). Change:

- Parse once at the top of `scanPayload` into `parsed: unknown | undefined`
  (undefined for `[DONE]`/malformed; keep raw string for the malformed-error
  fallback path in request-log).
- Add parsed-accepting variants: `inspectResponseLogSsePayloadParsed(logCtx,
  payload, parsed)`, `terminalStatusFromParsed(parsed)`,
  `firstOutputFromParsed(parsed)`, `completedResponseFromParsedEvent` (already
  parsed-based). Keep the string-based exports as thin wrappers so
  relay-eager/other callers and existing tests stay source-compatible.

## 080.5 — tee disconnect ownership (core.ts, BOTH consumers)

Today `linkAbortSignal(upstream, turnAc.signal)` is one-way; client disconnect
cancels the client tee branch and aborts `upstream`, but the inspection
consumer's `turnAc` never fires and its reader ends only via upstream error
propagation. Change in the tee branch of `core.ts` (~1679 onward):

- Pass a new `onClientDisconnect` notification from the client-branch cancel
  that starts a bounded drain in the inspection consumer: mark `clientGone`,
  allow up to 15 s / 32 MiB further inspection (late-terminal capture,
  mirroring relay-eager's drain contract), then `reader.cancel()` + inspector
  `dispose()` + `unregisterTurn(turnAc)`.
- **Abort ownership transfer (R2-2):** on the tee path, the client relay's
  `cancel()` no longer aborts `upstream` directly — the current immediate
  `upstream.abort()` (relay.ts:84) kills the inspection branch before a late
  terminal can arrive, defeating the drain. Instead `cancel()` fires the
  clientGone notification only; the bounded pump OWNS the abort and calls
  `upstream.abort()` + `reader.cancel()` when the drain ends (terminal seen,
  15 s, or 32 MiB). The win32 native path (no JS client relay wrapper) is
  unchanged. Regression: client cancel with a late terminal arriving at ~5 s
  → terminal recorded as completed/failed, THEN upstream aborted.
- Implementation shape (audit blocker 5): factor ONE shared bounded pump used
  by BOTH `consumeForInspection` and `consumeForResponseLogMetadata`
  (`recordTerminalOutcomes:false` traffic uses the latter — core.ts:1683/1719
  today). Both accept the optional `drainBounds` + caller-provided
  `clientGoneSignal` (AbortSignal). Existing behavior unchanged when not
  provided (win32 native path, tests).
- Counter: `postCancelDrainStops` increments when the bounded drain (not a
  protocol terminal) ends inspection.

## 080.6 — observability counters

- New module-level counter object in `relay.ts` (exported getter,
  `resetInspectionCountersForTest()` for tests):
  `{ frameBufferHighWaterBytes, completedItemsMaxCount, frameCapOverflows,
  itemCapEvictions, postCancelDrainStops }`. High-water values are monotonic
  process-lifetime maxima; counts are monotonic totals.
- Expose as `inspectionCounters` in the `GET /api/system/memory` payload
  (`system-routes.ts` handler already aggregates watchdog + responseState;
  add the getter call). `ocx observe memory --json` prints the same payload —
  no CLI change needed.
- docs-site note deferred to 110 (single docs commit).

## Regression tests (new file `tests/sse-inspector-bounds.test.ts` + extensions)

1. Oversized un-delimited frame → inspection keeps ≤ cap, `frameCapOverflows`
   increments, client bytes unaffected (feed same chunks through tee fixture),
   post-overflow resync parses the next event correctly.
   Includes: a SINGLE chunk larger than the cap (rejected before decode), and
   a large consumed prefix + small trailing partial frame (no overcharge —
   the partial frame still parses when its delimiter arrives).
   Also: a >4 MiB chunk composed of many small delimited frames parses fully
   with NO overflow (per-candidate accounting, R2-1); delimiter-parity cases
   for `\n\n`, `\r\n\r\n`, `\r\n\n`, `\n\r\n`, each split across chunks.
2. Frame split across chunk boundaries just under cap parses normally
   (no false overflow); delimiter split across chunks while discarding still
   resyncs.
3. 300 distinct `output_item.done` indexes → map holds ≤ 256, lowest retained,
   `itemCapEvictions` counts; aggregate-bytes eviction with few huge items.
   Taint: after any eviction, an empty-output `response.completed` does NOT
   produce a reconstructed partial output (no `onCompletedResponse` call →
   no truncated replay persisted); a terminal WITH authoritative output still
   fires with that output.
4. `response.completed` → map cleared after callback (feed a second response
   through the same inspector; reconstruction must not see stale items).
   Terminal failed/incomplete → map cleared without callback.
5. `dispose()` clears state; BOTH consumers' `finally` call it (spy).
6. Parse-once: instrument `JSON.parse` via a counting payload replayer —
   exactly 1 parse per complete payload with all hooks enabled (was 5).
7. Disconnect drain (both consumers): client cancel with a still-producing
   upstream → inspection stops within drain bounds, reader cancelled, turn
   unregistered, `postCancelDrainStops` increments; late terminal within
   window still records completed/failed (existing #44 contract preserved).
8. `/api/system/memory` payload contains `inspectionCounters` (extend the
   existing system-memory endpoint test).

## Commits

- `fix(relay): bound the SSE inspector and clear reconstruction state`
- `feat(observe): expose inspection retention counters on /api/system/memory`
(second commit only if the diff separates cleanly; otherwise one commit)

## wp3 C-review round 1 synthesis (reviewer Pauli, FAIL 3)

| # | Finding | Decision | Fix |
|---|---|---|---|
| C1-1 High | Pump races every `reader.read()` against ONE shared pending `drainStop` promise → O(chunk-count) promise reactions retained on long streams (new unbounded retention, the exact class this phase removes) | ACCEPT | Remove the race entirely: drain-stop resolution now calls `reader.cancel()` directly (flag `drainStopped`), so the pending read settles and the loop breaks; no reaction accumulates. `drainStopped` checked before the done-path so a drain stop is not treated as clean EOF. |
| C1-2 Med | `hasAuthoritativeOutput` treated non-array non-null output as authoritative — behavior drift: old code reconstructed whenever output was not a non-empty array; malformed `output:{}` would now reach `rememberResponseState` and be rejected, losing continuation state | ACCEPT | Authoritative = `Array.isArray(output) && output.length > 0`, restoring prior untainted behavior exactly. |
| C1-3 Med | Missing regressions: oversized candidate never decoded (decode spy), `finish()` during discard parses nothing, repeated `dispose()` idempotent | ACCEPT | Tests added (TextDecoder.decode spy asserts no ≥cap decode; finish-while-discarding asserts zero JSON.parse and no terminal; double-dispose). C1-1's mechanism is structurally gone (no shared race), covered by the silent-upstream drain-timer test. |
