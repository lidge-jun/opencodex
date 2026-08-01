# 132.00 — Plan: WebSocket Correctness and 1.9.0 Release

## Goal

Fix the Phase 120 WebSocket transport findings against current Codex RS, then ship opencodex as
version 1.9.0.

This phase is C4 because it changes a long-lived transport, Codex provider capability
advertisement, push/main merge state, and npm release behavior.

## Sources Checked

- OpenAI WebSocket mode docs: `generate=false` warmup returns a response ID that may be chained
  with `previous_response_id`.
- Current Codex RS local checkout:
  `/Users/jun/Developer/codex/openai-codex/codex-rs/core/src/client.rs`
  - `responses_websocket_enabled()` gates on provider `supports_websockets`.
  - `prepare_websocket_request()` sends incremental `input` with `previous_response_id` only when
    the prior response id is nonempty; empty id forces a full request.
- Current Codex RS local checkout:
  `/Users/jun/Developer/codex/openai-codex/codex-rs/codex-api/src/endpoint/responses_websocket.rs`
  - EOF or close before `response.completed` becomes a stream error.
  - Standalone `{ "type": "error", "status": ..., "headers": ... }` maps to HTTP-style transport
    errors.
- Bun WebSocket docs: `ServerWebSocket.send()` returns `-1`, `0`, or positive byte count; `0`
  means the message was dropped.

## Findings to Close

1. Routed follow-up requests cannot resolve `previous_response_id`.
2. Any 2xx body is treated as SSE, causing JSON/HTML/empty success stalls.
3. WS pumping does not enforce exactly one terminal event.
4. Native response headers are not preserved or represented on the WS path.
5. Interrupt parity is only socket-close parity.
6. HTTP error status and retry headers are wrapped as in-band `response.failed`.
7. SSE framing is too narrow and ignores WebSocket send drops/backpressure.
8. WebSockets are advertised by default before correctness is complete.
9. The socket stores all inbound headers instead of an allowlisted subset.

## PABCD Cycle Map

### Cycle 1 — Research and Safety Defaults

Modify:

- `/Users/jun/Developer/new/700_projects/opencodex/.gitignore`
- `/Users/jun/Developer/new/700_projects/opencodex/src/config.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/types.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/codex-inject.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/tests/codex-inject.test.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/tests/codex-catalog.test.ts`

Plan:

- Change `websocketsEnabled(config)` from absent-is-on to explicit opt-in:
  `config.websockets === true`.
- Change fresh default config from `websockets: true` to `websockets: false`.
- Update comments/tests to say WebSocket support is opt-in until 132 protocol gates pass.
- Keep catalog and provider table synchronized when the flag is explicitly true.
- Add `.tmp/` to `.gitignore` so repo-local scratch output does not block the clean-tree release
  helper.

Acceptance:

- Default injected provider table has no `supports_websockets`.
- Explicit `{websockets:true}` advertises provider/catalog WebSocket support.
- Explicit `{websockets:false}` suppresses both.

### Cycle 2 — WS Protocol Core

Modify:

- `/Users/jun/Developer/new/700_projects/opencodex/src/ws-bridge.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/server.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/types.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/responses/parser.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/tests/ws-endpoint.test.ts`

Plan:

- Store only allowlisted inbound WS headers in `WsData`.
  - Inbound allowlist: reuse `FORWARD_HEADERS`; do not retain cookies or unrelated upgrade headers.
  - Outbound safe header allowlist: `retry-after`, `x-request-id`, `openai-request-id`,
    `x-codex-turn-state`, `openai-model`, `x-models-etag`, `x-reasoning-included`, and
    `x-ratelimit-*`.
- Add routed continuation safety:
  - preserve parsed `previous_response_id` in `OcxParsedRequest`;
  - for routed/non-passthrough WS responses, emit empty response ids so Codex sends a full next
    request rather than an unresolved incremental suffix;
  - native passthrough keeps upstream ids.
- Replace `pumpSseToWebSocket()` with a protocol pump that:
  - decodes CRLF/LF SSE, multiline `data:`, arbitrary chunks, and unterminated final events;
  - validates JSON payloads;
  - detects terminal `response.completed`, `response.failed`, `response.incomplete`;
  - sends exactly one terminal and cancels upstream after terminal;
  - converts EOF/read failure before terminal into standalone `type:error`;
  - checks `ws.send()` results; treat `0` as failed/dropped, and treat `-1` as accepted with
    backpressure so the socket remains usable unless a later send drops.
- Change WS request execution to track one in-flight turn per socket:
  - a new `response.create` cancels the previous in-flight reader before starting the new turn;
  - a per-turn generation id prevents stale frames from the cancelled turn reaching the socket.
- Classify response bodies before pumping:
  - actual SSE via content-type or bounded sniff;
  - Responses JSON converted into a valid event sequence;
  - empty/unexpected success converted to protocol error.
- Emit standalone WS error envelopes for transport failures with safe headers and status.
- Add safe response header allowlist for WebSocket error/metadata paths.

Acceptance:

- Unit tests fail before/fix after for continuation empty id, JSON 200 conversion, HTML/empty
  protocol errors, duplicate terminal isolation, EOF-before-terminal error, CRLF/multiline/final
  unterminated SSE, dropped terminal send, `-1` backpressure tolerance, inbound header minimization,
  outbound safe-header filtering, and same-socket new-turn cancellation.

### Cycle 3 — Codex-Facing Verification

Modify:

- `/Users/jun/Developer/new/700_projects/opencodex/tests/ws-endpoint.test.ts`

New:

- `/Users/jun/Developer/new/700_projects/opencodex/devlog/132_websocket-correctness-release/10_verification.md`

Plan:

- Add targeted tests for:
  - routed two-turn socket where second frame has `previous_response_id` and suffix only;
  - routed tool-result follow-up preserving context through empty response ids;
  - native passthrough preserving upstream ids and safe headers;
  - non-2xx error envelope with `status`, `error`, and safe headers;
  - same-socket new-turn cancellation proving stale frames are not delivered after a logical
    interrupt-like replacement turn.
- Run:
  - `bun test tests/ws-endpoint.test.ts`
  - `bun test tests/codex-inject.test.ts`
  - `bun test tests/codex-catalog.test.ts`
  - `bun test tests`
  - `bun x tsc --noEmit`
- Run live `ocx` smoke with `websockets:false` default to confirm Codex no longer selects WS by
  default; explicit `websockets:true` can be tested with direct WS script.

Acceptance:

- All local gates pass.
- `ocx` ends stopped.
- Verification doc records exact commands and residual limitation: socket-close cancellation and
  same-socket new-turn cancellation are proven locally; a human-visible TUI Ctrl-C interrupt may
  still require a Codex-driven manual/live transcript if automation cannot inject it reliably.

### Cycle 4 — Push, Main Merge, and 1.9.0 Release

Modify:

- `/Users/jun/Developer/new/700_projects/opencodex/package.json`

Plan:

- Commit Phase 132 implementation and docs on `dev`.
- Push `dev` to `origin`.
- Merge `dev` into `main` after local gates pass and `git status --porcelain` is clean.
- Run release flow for `1.9.0 --publish` from clean `main`.
- Watch GitHub Release workflow to completion.
- Verify npm registry:
  - `npm view @bitkyc08/opencodex@1.9.0 version`
  - `npm dist-tag ls @bitkyc08/opencodex`

Acceptance:

- `origin/main` contains the 1.9.0 release commit.
- GitHub Release workflow passes.
- npm shows `@bitkyc08/opencodex@1.9.0`.
- Local `ocx status` is not running.

## Non-Goals

- Full state reconstruction for routed providers is not required in this phase if the empty-id
  conservative behavior is implemented and tested.
- Native upstream WebSocket-to-WebSocket bridging is not required; native passthrough may continue
  HTTP Responses upstream as long as Codex-facing WS protocol behavior is correct.
- Non-representable provider modalities outside the current opencodex/jawcode type model are out of
  scope.
