# 11 — Diff-level plan: src/bridge.ts (NOT applied)

Two paths must change identically: streaming and non-streaming. The cleanest
implementation reroutes `reasoning_raw_delta` into the summary accumulator that
already exists for `thinking_delta`.

## Streaming path

### Source today
- `reasoning_raw_delta` case (src/bridge.ts:298) accumulates `currentRawReasoning`
  and emits `response.reasoning_text.delta` (content channel).
- `closeCurrentRawReasoning` (src/bridge.ts:193) emits a final item with
  `summary: []`, `content: [{ reasoning_text }]`.
- `thinking_delta` case (src/bridge.ts:276) accumulates `currentReasoning` and
  emits `response.reasoning_summary_text.delta`; `closeCurrentReasoning`
  (src/bridge.ts:174) finalizes `summary: [{ summary_text }]`.

### Proposed change (reroute)
- In the `reasoning_raw_delta` case, route into the SAME accumulator/events as
  `thinking_delta`: open/extend `currentReasoning`, emit
  `response.reasoning_summary_part.added` (once) + `response.reasoning_summary_text.delta`,
  and let `closeCurrentReasoning` finalize `summary: [{ summary_text }]`.
- Honor `options?.hideThinkingSummary` exactly as the thinking path does (bridge.ts:277).
- Net effect: routed reasoning_content now travels the summary channel.

### Decision point (see 90)
- Keep `closeCurrentRawReasoning` / the content channel for any other producer of
  `reasoning_raw_delta`? If `reasoning_content` is the only producer, the raw path
  can be retired; otherwise keep it and gate the reroute to the chat adapter.

## Non-streaming path

### Source today
- `reasoning_raw_delta` case (src/bridge.ts:530) accumulates `currentRawReasoning`.
- `flushRawReasoning` (src/bridge.ts:476) pushes `{ summary: [], content:[reasoning_text] }`.
- `flushSummaryReasoning` (src/bridge.ts:468) pushes `{ summary: [{summary_text}] }`
  and respects `hideThinkingSummary` (bridge.ts:469).

### Proposed change
- Route the non-streaming `reasoning_raw_delta` into `currentSummaryReasoning`
  (the summary accumulator) so `flushSummaryReasoning` emits a non-empty
  `summary[]`, mirroring the streaming change. Keep `hideThinkingSummary` behavior.

## Invariants preserved
- text / tool-call flows untouched.
- `thinking_delta` (Anthropic) path unchanged.
- Only the reasoning-item SHAPE for chat reasoning_content changes
  (summary populated instead of content).
