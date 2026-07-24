# 001 — SSE Pipeline Map (research, no diffs)

Source: read-only survey of `dev` @ 5157c490 (explorer Lagrange + main-agent
spot checks). Research only — implementation plans live in decade docs.

## Flow

```text
client (POST /v1/responses, /v1/chat/completions, /v1/messages, WS response.create)
  -> chat/inbound or claude/inbound normalization
  -> handleResponses (src/server/responses/core.ts:542)
       expandPreviousResponseInput (src/responses/state.ts:209)
       parseRequest (src/responses/parser.ts:227) -> _replayPrefixLen (:597)
       resolveAdapter (src/server/adapter-resolve.ts:27)
     |-- Native Responses passthrough (openai-responses / Azure)
     |     fetchWithHeaderTimeout + fetchWithTransientRetry (pre-header only)
     |     -> legacy tee() OR relaySseEagerBounded (bun-stream-caps decision)
     |     -> createSseInspector (src/server/relay.ts:438): terminal/TTFT/usage,
     |        output_item.done accumulation, completed snapshot reconstruction
     |-- Routed providers (openai-chat / anthropic / google / kiro / cursor / mimo)
           adapter.parseStream -> AdapterEvent (src/types.ts:225)
           -> bridgeToResponsesSSE (src/bridge.ts:79)
                output_item lifecycle, terminal events, heartbeat/stall, [DONE]
  -> downstream: verbatim Codex SSE | chat/outbound.ts -> chat.completion.* + [DONE]
     | claude/outbound.ts -> message_start/content_block_*/message_stop
     | ws-bridge.ts -> WS text frames
```

Replay loop: response.output_item.done events -> completed snapshot ->
rememberResponseState (state.ts:244) -> next previous_response_id ->
expandPreviousResponseInput -> WeakMap replay prefix ->
injectDeveloperMessage dedupe (server/responses/collaboration.ts:295).

## Key boundaries

- Native passthrough client branch is byte-verbatim; reconstruction touches
  only the local persistence snapshot.
- Routed path normalizes everything through AdapterEvent; the bridge
  synthesizes Responses SSE.
- fetchWithTransientRetry never retries mid-stream (upstream-retry.ts:203).
- Two decoder contracts exist: byte-preserving passthrough scanners vs
  event-aware reserializers (shared decodeServerSentEvents, sse-decoder.ts).

## Already hardened (bugfix train, do not redo)

- dad32624: inspector reconstructs dropped output items when terminal output
  is empty/missing (relay.ts:488-497), non-empty terminal authoritative.
- da97a560: persistence-capable inspector parses each SSE payload once.
- 2f9eb0fd: replayed developer guidance dedupe via _replayPrefixLen.
- 4b60f5ee: regression coverage for the above (responses-state, relay-eager,
  multi-agent-compat).
- openai-chat adapter: EOF fail-closed without [DONE]/finish_reason/usage
  (openai-chat.ts:718-728); malformed SSE data frame -> terminal error.
- sse-decoder: arbitrary chunk boundaries, CRLF, multiline data, EOF
  residual, abort-cancel (42 tests green).

## Test inventory (pointers)

bridge*.test.ts, sse-decoder, relay-eager, sse-failed-tail,
passthrough-abort/headers, responses-item-id-repair, responses-state,
request-log, bun-stream-caps, fetch-header-timeout, provider suites
(anthropic-*, openai-chat-*, google-*, kiro-stream, cursor-*),
chat-completions-endpoint, claude-outbound/messages-endpoint,
claude-native-passthrough, ws-endpoint, sidecar/web-search/vision suites.
