# WebSocket adapter usage logging incident

- Date: 2026-07-06
- Class: C2 runtime observability regression
- Loop mode: cxc-loop HITL evidence ledger. No HOTL goal was armed; the user requested a bounded diagnosis, fix, verification, and devlog record.
- Terminal outcome: DONE

## Symptom

The local request log showed recent routed Anthropic requests with HTTP 200 but
`usageStatus: "unreported"` and no cache-token accounting. Nearby OpenAI passthrough
requests continued to report usage, including cache tokens, so this was not a
global request-log outage.

The live profile that mattered:

- affected rows: routed adapter over `/v1/responses` WebSocket, `status: 200`, no
  `terminalStatus`, no `closeReason`, no usage metadata.
- unaffected rows: native OpenAI passthrough and HTTP/SSE response paths, where
  the log inspector still saw terminal events and usage payloads.
- cache parser state: Anthropic adapter already maps `cache_read_input_tokens` and
  `cache_creation_input_tokens` into reported cached input token fields.

## Recent-100 commit finding

`1496b93 feat(anthropic): improve prompt caching and provider timeouts` was a
plausible suspect because it changed Anthropic prompt caching, but it was not the
root cause. The parser and adapter usage tests covered the cache fields.

The recent exposing change was Design B:

- `eea62f1 feat: Design B injection - point built-in openai provider at the proxy`
- follow-up hardening through `22561a4`

Design B caused plain Codex traffic to use the built-in OpenAI provider with
`openai_base_url` pointed at ocx. That increased use of the `/v1/responses`
WebSocket path. The WebSocket endpoint itself is older than the last 100 commits;
the recent change exposed a pre-existing request-log inspection gap.

## Hypotheses

Rejected: Anthropic stopped returning usage.

- Counter-evidence: some Anthropic rows still reported usage, and a fake upstream
  emitting `message_start` plus `message_delta` usage reproduced the correct
  fields once the WebSocket inspection gap was closed.

Rejected: Anthropic cache-token parsing was broken.

- Counter-evidence: `src/adapters/anthropic.ts` folds
  `cache_read_input_tokens + cache_creation_input_tokens` into cached input usage,
  and `tests/adapter-usage.test.ts` already covers that shape.

Rejected: the dashboard rendered usage incorrectly.

- Counter-evidence: raw request-log records lacked usage and terminal metadata
  for the affected WebSocket rows.

Confirmed: WebSocket SSE re-framing forwarded payloads to the client but did not
feed those payloads to the request-log SSE inspector.

- HTTP `/v1/responses` used `responseWithDeferredRequestLog`, which inspects SSE
  payloads while streaming.
- native OpenAI passthrough used a background metadata consumer for log inspection.
- routed adapters returning SSE through WebSocket used `sendResponseToWebSocket`
  and `pumpResponsesSseToWebSocket`, but those functions had no request-log
  payload observer.

## Fix

Patch surface:

- `src/ws-bridge.ts`: added an `onSsePayload` observer to the SSE-to-WebSocket
  pump. It observes every non-`[DONE]` SSE data payload before the payload is
  sent as a WebSocket text frame. Observer exceptions are swallowed so logging
  cannot break delivery.
- `src/ws-bridge.ts`: extended the same observation point to successful JSON
  fallback responses that are synthesized into Responses WebSocket events. The
  incident path was SSE, but the JSON fallback had the same re-framing-without-
  observation shape and is now covered by the same hook.
- `src/server.ts`: the WebSocket `response.create` path now passes each observed
  SSE payload into `inspectResponseLogSsePayload(logCtx, payload)`.
- `src/server.ts`: terminal WebSocket completion now finalizes request logs with
  `terminalStatus` and `closeReason: "terminal"`, matching the shape the GUI and
  log API expect.

Regression coverage:

- `tests/ws-endpoint.test.ts`: asserts that the WebSocket pump observes SSE
  payloads while still forwarding the same frames, and that JSON fallback
  Responses events are observable before terminal finalization.
- `tests/server-auth.test.ts`: adds an Anthropic routed-adapter WebSocket
  integration test. The fake upstream emits:
  - `input_tokens: 20`
  - `cache_read_input_tokens: 3`
  - `cache_creation_input_tokens: 2`
  - `output_tokens: 4`

Expected log result:

- `status: 200`
- `terminalStatus: "completed"`
- `closeReason: "terminal"`
- `usageStatus: "reported"`
- `totalTokens: 29`
- `usage.inputTokens: 25`
- `usage.outputTokens: 4`
- `usage.cachedInputTokens: 5`

## Why other paths did not show the same problem

The other paths had independent log-inspection hooks after the Design B change:

- HTTP/SSE response path: `responseWithDeferredRequestLog` already inspects SSE
  payloads and finalizes logs after the stream closes.
- native OpenAI passthrough: the passthrough branch duplicates the response stream
  and consumes one copy for request-log metadata.
- routed adapter WebSocket path: before this fix, it only re-framed SSE to WS and
  reported terminal status. It did not inspect payloads for usage.

So the failure was transport-specific, not provider-wide and not cache-parser-wide.

## Verification

Fresh checks from this repair:

- `bun run typecheck` - pass
- `bun test tests/adapter-usage.test.ts tests/request-log.test.ts tests/ws-endpoint.test.ts tests/server-auth.test.ts` - pass, 99 tests / 287 expects
- Note: an earlier non-loop repair attempt restarted the local proxy. The cxc-loop
  patch pass did not run `ocx restart`, `ocx stop`, `ocx start`, `ocx ensure`, or
  `ocx sync`.

## Prevention rule

Any future transport that re-frames Responses SSE into another delivery protocol
must provide a request-log payload observation point, and regression coverage must
assert a routed adapter reports usage through that transport.

## cxc-loop addendum

- P: `010_phase1_ws_usage_log_patch.md` records the repair loop scope and excludes
  `ocx` lifecycle commands.
- A: `gpt-5.5` reviewer PASSed the SSE fix and identified the JSON fallback
  observation gap as a residual risk.
- B: JSON fallback observation was added to the same bridge hook instead of leaving
  a parallel re-framing path unobserved.
- C: `bun run typecheck` and the focused four-file test suite passed.
