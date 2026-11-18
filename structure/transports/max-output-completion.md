# Opt-in Responses text completion

`completeOnMaxOutputTokens` is an optional boolean in `src/config/schema/config-schema.ts`
and `src/types/config.ts`. Absence, false and malformed values leave it off.
`src/server/responses/adapter-delivery.ts` and `src/server/responses/run-turn-execution.ts`
pass request-local opt-in and parsed `textFormat` only to translated Responses delivery.
Chat and Messages retain their existing stop semantics. Native Responses passthrough,
including native WebSocket delivery, does not participate or reload configuration for this policy.

`src/bridge/max-output-completion.ts` observes the original adapter events before bridge cleanup.
Only nonempty plain text, optional message boundaries and heartbeats qualify. Any tool or
hosted operation, including one later closed by bridge cleanup or explicitly completed,
excludes the turn. Reasoning (including hidden and signed progress), structured `textFormat`,
compaction and explicit `endTurn: false` also exclude it. The allowlist excludes future event
types until they are explicitly reviewed. Errors and missing terminals retain their failure
or incomplete shape. Raw `max_tokens`, `length` and `max_output_tokens` stops qualify;
`pause_turn` and context-window exhaustion remain incomplete even though the general
truncation classifier maps them to the same public incomplete reason.

The builders in `src/bridge/sse.ts` and `src/bridge/response-json.ts` turn an eligible
terminal into `completed` and omit `incomplete_details`. The model's text
is unchanged, including earlier messages, open Markdown and valid empty fenced blocks.
Usage, `end_turn` and provider continuation state survive both buffered and streamed delivery.
Compaction retains its existing history and retention-commit rules, without placeholders.

`tests/responses/graceful-max-output-tokens-exclusions.test.ts` covers both bridge shapes
and terminal forms. `tests/responses/graceful-max-output-tokens.test.ts` exercises the
real server's adapter and runTurn delivery, both structured formats, Chat/Messages stop
semantics, malformed/default config, native WS framing and no config reload after reservation.
