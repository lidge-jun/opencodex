# 050 — Issue #875: DeepSeek V4 Flash HTTP/SSE stall after tool calls

core.ts cluster 3/3. Research: explorer batch E (read PR #1006 fully).
Decision: **supersede PR #1006 as a diff, retain contributor attribution and
its core policy** (bounded upstream JSON for this model).

## Verified current state

- Bounded upstream JSON applies only when `inboundTransport === "websocket"`:
  `src/server/responses/core.ts:846`. The registry flag only disables WS
  upstream streaming: `src/providers/registry.ts:1143`. Ordinary HTTP keeps
  `stream:true`, classifies the response as SSE (`core.ts:1877`), enters the
  native relay (`core.ts:1967`), which closes early only on a protocol
  terminal (`src/server/relay.ts:196`). A stream emitting tool output but no
  usable terminal hangs — the reporter's `websockets:false, bodyKind:sse`
  reproduction at e44d234f0.
- #1006's mechanism is causally right (force `stream:false`) but: duplicates
  the JSON→event algorithm already in `sendResponsesJsonAsEvents()`
  (`src/server/ws-bridge.ts:295`); adds persistent parser state
  `_clientRequestedStream`; omits the `[DONE]` trailer; its test never proves
  the old path hangs; and bounded JSON would bypass the SSE item-ID repair
  branch (undermines #938).

## Diff-level plan

MODIFY `src/providers/registry.ts` — rename the registry-only WS concept to
transport-neutral `modelResponsesUpstreamStreaming`; DeepSeek Flash stays
`false`; apply only after final wire resolution and only when the resolved
adapter is `openai-responses`.

ADD `src/server/responses-json-events.ts` — extract the pure event sequence
from `sendResponsesJsonAsEvents()` (`response.created` → one
`response.output_item.done` per output item → status-preserving terminal) +
an SSE serializer appending exactly one `data: [DONE]\n\n`; optional
client-facing payload rewrite hook (060 composes ID normalization here).

MODIFY `src/server/ws-bridge.ts` — use the shared helper; preserve payload
observation + terminal callbacks.

MODIFY `src/server/responses/core.ts` — capture
`const clientRequestedStream = parsed.stream` immediately before
`applyFinalRouteRequestNormalization()` (`core.ts:1479`); after final adapter
resolution apply the transport-neutral policy (`stream:false` upstream); in
the bounded JSON branch (`core.ts:2124`): parse once after existing
byte/inactivity limits; record the raw response first; apply client-facing
ID normalization; return JSON unchanged for non-streaming clients and WS;
serialize terminal SSE + `[DONE]` for HTTP clients that requested streaming;
strip stale `content-length`/`content-encoding`, set SSE content type +
no-store.

MODIFY `tests/deepseek-inbound-wire.test.ts` — replace the HTTP-keeps-
streaming assertion (`:135`); add the stall activation below.
MODIFY `tests/ws-endpoint.test.ts` — WS/HTTP serializer parity over
completed/failed/incomplete/function-call/empty outputs.
ADD `tests/responses-json-events.test.ts`.
MODIFY `structure/04_transports-and-sidecars.md` — document the
transport-neutral policy.

## Tests / activation

Decisive regression: fake DeepSeek fetch — if the outgoing body has
`stream:true`, return an SSE stream with a completed `function_call` but no
terminal frame and never close (old code: times out); if `stream:false`,
return the completed JSON. Fixed code: downstream emits `created`,
`output_item.done(function_call)`, `completed`, `[DONE]`, closes before a
200-500ms deadline.

Matrix: plain message; one/multiple function calls; failed/incomplete status
preservation; malformed/oversized/total-timeout/inactivity-timeout JSON;
chat+anthropic inbound stays streaming on `/chat/completions`; WS unchanged;
UUID message/reasoning IDs normalized on both bounded-JSON paths (with 060).

## Risks

- DeepSeek Flash loses progressive token delivery — intended provider
  reliability tradeoff, stated in the PR body.
- HTTP event parity must be tested (WS proves `output_item.done` suffices for
  function calls).
- Bounded-body limits stay mandatory (HTTP now materializes routinely).

## Accept criteria

- Stall activation test red→green; WS/HTTP parity green; gates as 030.
