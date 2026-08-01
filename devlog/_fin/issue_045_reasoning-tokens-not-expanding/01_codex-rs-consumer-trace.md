# Issue #45 — codex-rs consumer-side trace (response + codex-rs investigation)

Follow-up to 00_review.md. The user asked whether the real problem is on the
`response` / **codex-rs** (Codex client) side, not just opencodex's bridge.
This doc traces the full path through codex-rs `main` (fetched 2026-06-29) and
records exactly what each event does on the consumer.

## Short answer

The opencodex root-cause in 00_review.md is **correct AND necessary**, but the
codex-rs side has a real, decisive nuance that the original review didn't capture:

- codex-rs does NOT discard raw reasoning `content` — it parses and maps it.
- But the two reasoning shapes land in **different render channels**, and the
  expandable/visible trace the reporter expects comes from the **summary** path.
- So the fix must put routed reasoning into `summary[]` (00_review Approach 1).
  This is confirmed by the codex-rs code, not just inferred.

## End-to-end trace (opencodex → codex-rs)

### 1. opencodex emits (src/bridge.ts)
- `thinking_delta` → `response.reasoning_summary_text.delta` + a final item
  `{ reasoning, summary:[{summary_text}] }`  (bridge.ts:174-195, 276-296)
- `reasoning_raw_delta` → `response.reasoning_text.delta` (with `content_index:0`)
  + a final item `{ reasoning, summary:[], content:[{reasoning_text}] }`
  (bridge.ts:193-206, 298-313)

### 2. codex-rs SSE parser — codex-api/src/sse/responses.rs
- `"response.reasoning_summary_text.delta"` → `ResponseEvent::ReasoningSummaryDelta`
  (requires `delta` + `summary_index`) — responses.rs:343
- `"response.reasoning_text.delta"` → `ResponseEvent::ReasoningContentDelta`
  (requires `delta` + `content_index`) — responses.rs:351
  opencodex DOES send `content_index:0`, so this parses fine. Not the bug.

### 3. codex-rs turn loop — core/src/session/turn.rs
- `ResponseEvent::ReasoningSummaryDelta` → `EventMsg::ReasoningContentDelta`
  (the SUMMARY stream; turn.rs:2290-2309)
- `ResponseEvent::ReasoningContentDelta` → `EventMsg::ReasoningRawContentDelta`
  (the RAW stream; turn.rs:2326-2345)
- Both require an `active_item` that is `streaming_to_client`; that active item
  is established by `OutputItemAdded` (turn.rs:2082). opencodex emits
  `response.output_item.added` for both shapes, so the active item exists.

### 4. Final history item mapping — core/src/event_mapping.rs:167-192
`ResponseItem::Reasoning { summary, content }` maps to BOTH:
- `summary_text` ← `summary[].summary_text`
- `raw_content`  ← `content[].reasoning_text | text`
So `content` is preserved into the TurnItem — NOT dropped at the protocol layer.

### 5. Request-side gate — core/src/client.rs:785-808 `build_reasoning`
Reasoning request params are only sent when `model_info.supports_reasoning_summaries`.
This is keyed on the model catalog, and the "Worked for Xs" timer is driven by
elapsed time / `reasoning_tokens` usage independent of any summary content.

## Why the trace still points back to opencodex

Although codex-rs carries `content` (raw_content) all the way to the TurnItem,
the **expandable, persisted reasoning the reporter expects is the summary
channel** (`ReasoningSummaryCell` / `new_reasoning_summary_block`,
tui/src/history_cell/messages.rs:197-506). Native OpenAI models populate
`summary`; opencodex's `reasoning_raw_delta` path leaves `summary` empty and only
fills `content`. Result: timer shows, expandable summary is empty — exactly the
report.

Therefore the **actionable fix is still opencodex-side**: mirror raw reasoning
into `summary[]` (00_review.md Approach 1). codex-rs needs no change — it already
renders summary-channel reasoning for any model; opencodex just isn't feeding
that channel for chat-completions `reasoning_content`.

## Sub-case B unchanged
Models that emit no `reasoning_content` at all (many free models) have nothing to
surface; "Worked for Xs" is pure elapsed time. Model limitation, not a bug.

## Evidence (codex-rs main, fetched 2026-06-29)
- codex-rs/codex-api/src/sse/responses.rs:343,351 (event parse)
- codex-rs/core/src/session/turn.rs:2082,2290,2326 (event routing + active-item gate)
- codex-rs/core/src/event_mapping.rs:167-192 (summary_text vs raw_content)
- codex-rs/core/src/client.rs:785-808 (supports_reasoning_summaries gate)
- codex-rs/app-server/README.md:1373,1407-1409 (summary = most OpenAI models;
  content/textDelta = open-source models)
- codex-rs/tui/src/history_cell/messages.rs:197-506 (ReasoningSummaryCell render)

## Conclusion
Not a codex-rs bug. The user's instinct to check the consumer was right, and the
trace strengthens (not overturns) 00_review.md: codex-rs renders the summary
channel; opencodex must route chat `reasoning_content` into `summary[]`. The fix
remains small, opencodex-only, low-risk.
