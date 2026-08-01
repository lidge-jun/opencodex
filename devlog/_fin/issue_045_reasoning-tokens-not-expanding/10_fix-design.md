# 10 — Fix design: route reasoning_content through the summary channel

## Decision
Make chat-completions `reasoning_content` populate the Responses `reasoning`
item's **`summary[]`** (not just `content[]`), so codex-rs renders an expandable
trace for routed models — matching native OpenAI models.

## Why (grounded in the codex-rs trace, see 01_codex-rs-consumer-trace.md)
- codex-rs renders the persisted / expandable reasoning block from the **summary
  channel** (`ReasoningSummaryCell`, tui/src/history_cell/messages.rs:197-506).
- Native OpenAI models fill `summary`; opencodex's `reasoning_raw_delta` path
  fills only `content` and leaves `summary: []` → timer shows, nothing to expand.
- Non-OpenAI chat providers (DeepSeek-R-style) do NOT emit a separate condensed
  summary stream. Their full `reasoning_content` IS the human-visible thinking,
  so it legitimately belongs in `summary`.

## Chosen approach: reroute (summary-only), not dual-emit
Treat `reasoning_content` like `thinking_delta` — send it through the existing,
already-proven **summary path** (`closeCurrentReasoning` / `flushSummaryReasoning`)
instead of the raw path. Rationale:
- Reuses a validated code path and its events
  (`response.reasoning_summary_text.delta` + `…part.added/.done`).
- Avoids emitting the same text into BOTH `summary[]` and `content[]` (no
  double-render risk, no ambiguity about which channel codex-rs prefers).
- Keeps `hideThinkingSummary` honoring identical to the thinking path.

(Alternative "mirror into both" is documented in 20_alternatives-and-risk.md;
rejected as the default for dedupe clarity.)

## Scope guard
- openai-chat reasoning_content only. The `thinking_delta` (Anthropic-style)
  path is unchanged. The anthropic adapter is unaffected.
- This doc is design-only; the diff lives in 11, tests in 12. NO code this cycle.
