# 30 — Implementation: reroute chat reasoning_content to the summary channel

Status: APPLIED (2026-06-29). Implements Approach A from 10_fix-design.md /
20_alternatives-and-risk.md (reroute to summary-only, not mirror-into-both).

## What changed (src/bridge.ts)
- Streaming `reasoning_raw_delta` case: routed through the same summary path as
  `thinking_delta`. It now opens/extends `currentReasoning`, emits
  `response.reasoning_summary_part.added` (once) + `response.reasoning_summary_text.delta`,
  and `closeCurrentReasoning` finalizes `summary: [{ summary_text }]`. The old
  content-channel emission (`response.reasoning_text.delta` + a final item with
  empty `summary` and `content: [{ reasoning_text }]`) is no longer produced for
  this input. `hideThinkingSummary` now suppresses it identically to thinking.
- Non-streaming `reasoning_raw_delta` case: accumulates into
  `currentSummaryReasoning` so `flushSummaryReasoning` emits a non-empty
  `summary[]`. `hideThinkingSummary` honored via the existing summary flush guard.
- `closeCurrentRawReasoning` / `flushRawReasoning` are retained (no other producer
  removed) but are no longer reached by the chat `reasoning_content` producer.

## Why this fixes #45
codex-rs renders the expandable / persisted reasoning trace from the SUMMARY
channel only (01_codex-rs-consumer-trace.md). Routed chat models previously filled
only `content`, leaving `summary` empty → Codex showed the "Worked for Xs" timer
with nothing to expand. Routing reasoning_content into `summary[]` gives routed
models the same expandable trace as native OpenAI models.

## Verification
- `bun test tests/bridge.test.ts` → 14 pass / 0 fail (updated streaming + non-stream
  assertions to summary channel; added hideThinkingSummary parity test).
- `bun run test` → 775 pass / 0 fail.
- `bun x tsc --noEmit` → exit 0.

## Sub-case B (unchanged)
Models that emit no `reasoning_content` at all still only show the timer — model
limitation, not an opencodex bug. Documented in 00_review.md.
