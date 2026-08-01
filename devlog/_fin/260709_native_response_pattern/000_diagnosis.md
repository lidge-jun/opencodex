# Native response pattern — diagnosis (WP1, 2026-07-09)

## Question
Routed chat models (GLM/xAI) get their tool cells split in the Codex app while native
GPT / Claude-via-ocx threads merge. What exactly splits, and what is the native shape?

## Evidence (Tier-2, gpt-5.5 explorers Gauss/Aquinas + local captures)
1. Grouping barriers (codex-rs TUI, openai/codex@dc23c7b): an exec group is extended only
   while BOTH cells are "exploring" (Read/ListFiles/Search); ANY visible history cell breaks
   the active group (chatwidget.rs L1220-1240). Reasoning DELTAS are not barriers; a COMPLETED
   reasoning item is a barrier only when it renders visible lines; an EMPTY reasoning item
   renders nothing and does not break grouping (replay.rs L112-126, streaming.rs L227-239).
   Desktop app source is closed; its aggregate rows behave consistently with this model.
2. Native wire shape: hosted reasoning is exposed ONLY as summary parts
   (`summary[]` + response.reasoning_summary_text.delta, optional encrypted_content); raw
   `content[reasoning_text]` is never emitted by hosted OpenAI models (OpenAI reasoning docs;
   codex-rs models.rs L970-979, event_mapping.rs L171-196).
3. opencodex bridge asymmetry (THE splitter):
   - anthropic `thinking_delta` path RESPECTS `options.hideThinkingSummary` — hidden thinking
     accumulates and flushes as an envelope-only reasoning item (empty summary, encrypted
     round-trip) — INVISIBLE to the app (bridge.ts:419, :228-235).
   - openai-chat `reasoning_raw_delta` path IGNORES the flag and always emits a visible raw
     reasoning item (`content[reasoning_text]` + reasoning_text.delta) (bridge.ts:452-469).
     Non-streaming twin: flushSummaryReasoning respects hidden; flushRawReasoning does not
     (bridge.ts:710-735).
4. Flag source: parser sets `hideThinkingSummary = true` when the request reasoning summary
   mode is absent or "none" (parser.ts:476). All routed catalog entries ship
   `default_reasoning_summary = "none"` (verified live against :10100), so real app requests
   carry summary none -> the flag IS true; only the raw path fails to honor it.
5. Live capture (glm-5.2, streamed, tools): item order is already native-like
   (reasoning -> function_call -> function_call -> completed); only the reasoning item SHAPE
   (raw content vs summary/hidden) diverges.

## Conclusion
The splitter is the visible raw reasoning item emitted by the `reasoning_raw_delta` path in
defiance of `hideThinkingSummary`. Fix = make the raw path honor the flag exactly like the
anthropic path, carrying the hidden text in the reasoning envelope so
`preserveReasoningContentModels` replay (GLM interleaved thinking) keeps working. Visible mode
(summary "auto") keeps the current raw shape — that is a user opt-in to visible thinking and
matches Codex's raw-reasoning support (recorded decision; converting raw->summary shape when
visible is cosmetic and out of scope this unit).
Client-side kind-splits (apply_patch cells, non-exploring commands) are Codex behavior shared
by native models — parity is the goal, not beyond-native merging.
