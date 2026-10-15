# Anthropic progress updates

`src/adapters/anthropic.ts` selects `thinking: {type: "adaptive", display: "updates"}` with
`thinking-display-updates-2026-08-18` only for Opus 5.5 on `api.anthropic.com`, for key and OAuth sends.
`src/types/request.ts` carries the complete signed update on its text-delta event.
`src/adapters/anthropic-progress.ts` uses this documented display contract to classify nonempty
thinking text as commentary, buffering one block under the translator budget until its final signature.
Signatures remain opaque; compatible gateways and other models keep their prior display mode.
Hidden-summary preferences suppress reasoning, not these user-facing updates.
Signed history preserves source block order, including thinking between tool calls; unsigned
cross-provider history retains the adapter's preface-before-tools repair.
`tests/adapters/anthropic/anthropic-progress-updates.test.ts` exercises SSE/JSON presentation,
exact replay, mixed block order, OAuth beta preservation and cancellation cleanup.

## Signed Anthropic progress commentary

`src/responses/anthropic-progress.ts` creates an empty-summary reasoning carrier followed by one
visible `phase: "commentary"` message for a documented Anthropic progress update. Its `ocxr1`
envelope stores the exact signed text and signature plus `upd`, the following message's ID.
`src/bridge/sse.ts` and `src/bridge/response-json.ts` preserve this pair even when summaries are hidden.
Compaction ignores signed progress events: only ordinary summary text enters the checkpoint,
and neither bridge emits the commentary pair during compaction.
`src/responses/parser.ts` removes only the adjacent commentary copy with matching ID (or no ID),
phase and exact text, leaving the original thinking block in source order. Edited copies remain.
`src/claude/outbound.ts` restores the signed thinking block and consumes the presentation copy on
both JSON and SSE conversions; ordinary locally hidden envelope text remains undisclosed.

`src/responses/assistant-replay.ts` preserves text, empty signed blocks, signature updates and
redacted blocks in order for the internal continuation builders in
`src/server/responses/terminal-guard.ts` and `src/server/responses/advisor-slot.ts`.
The hosted tool loops in `src/web-search/loop.ts`, `src/web-search/run-turn-loop.ts` and
`src/images/loop.ts` reconstruct progress events as signed thinking parts. Search's early
commentary path retains these events for the next iteration.
Intercepted search and image iterations emit their validated signed progress before fulfilling
the hosted calls, retaining the same blocks for replay and avoiding duplicate live updates.
