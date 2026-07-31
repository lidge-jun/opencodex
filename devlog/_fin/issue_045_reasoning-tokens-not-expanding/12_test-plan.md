# 12 — Test plan: tests/bridge.test.ts (NOT applied)

## Existing test to update
`tests/bridge.test.ts:30` "streaming raw reasoning emits reasoning_text deltas
and final raw content" currently asserts the BROKEN shape:
```
output[0] === { type:"reasoning", summary:[], content:[{reasoning_text:"raw detail"}] }
```
After the fix this assertion changes to expect a non-empty `summary[]`.

## New / updated assertions

### Streaming
- Feed `[{ type:"reasoning_raw_delta", text:"raw detail" }, { type:"done", ... }]`.
- Assert at least one `response.reasoning_summary_text.delta` frame with
  `delta:"raw detail"` (summary channel now active).
- Assert the final `reasoning` output item has
  `summary:[{ type:"summary_text", text:"raw detail" }]` (non-empty).
- If the content channel is retired (see 90), assert NO
  `response.reasoning_text.delta` for this input; if kept+gated, assert no
  duplicate text across both channels.

### hideThinkingSummary
- With `hideThinkingSummary: true`, assert reasoning_content produces NO summary
  output item (parity with the thinking path, bridge.ts:277/469).

### Non-streaming
- Non-stream replay with `reasoning_raw_delta` → assert the pushed `reasoning`
  item has a non-empty `summary[]` (flushSummaryReasoning path).

### Regression guards
- `thinking_delta` test (bridge.test.ts:55) still passes unchanged.
- Usage/token assertions (reasoning_tokens etc.) unchanged.

## Commands (when implemented — not this cycle)
- `bun test tests/bridge.test.ts`
- `bun x tsc --noEmit`
