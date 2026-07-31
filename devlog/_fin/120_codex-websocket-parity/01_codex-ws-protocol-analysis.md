# 120.01 — Codex Responses WebSocket Protocol Analysis

Reference map of the wire protocol Codex speaks on the WS path, derived by reading the **stable
codex checkout**. All citations are relative to:

```text
/Users/jun/Developer/codex/codex-cli/codex-rs/
```

Files: `codex-api/src/endpoint/responses_websocket.rs` (WS client), `codex-api/src/common.rs`
(request frames), `codex-api/src/provider.rs` (URL), `codex-api/src/sse/responses.rs` (event
schema — shared with SSE), `core/src/client.rs` (selection + headers).

This is the contract a Responses-WS **server** (opencodex) must satisfy. Implementation plans
(`10_`–`13_`) cite specific rows here.

## 1. Path selection (when Codex uses WS)

- Gated solely by `Provider.supports_websockets` (+ a runtime `disable_websockets` kill switch):
  `core/src/client.rs:772` → `if !provider.info().supports_websockets || disable_websockets { return false; }`.
- No `wire_api` gate in the WS code. The connection is opened lazily and **reused across turns**
  within a session (`core/src/client.rs:13-19`).

## 2. URL derivation

- `Provider::websocket_url_for_path()` (`codex-api/src/provider.rs:92-103`): swap scheme
  `http→ws`, `https→wss`; **path unchanged**. Called with `"responses"`
  (`responses_websocket.rs:378`).
- So a provider `base_url = http://localhost:10100/v1` yields `ws://localhost:10100/v1/responses`.

## 3. Handshake / upgrade

- **Auth is HTTP-upgrade-time only** (no per-frame auth): `auth.add_auth_headers(&mut headers)`
  on the upgrade request (`responses_websocket.rs:383`).
- Beta header `OpenAI-Beta: <RESPONSES_WEBSOCKETS_V2_BETA…>` (`core/src/client.rs:912-914`),
  plus session/request headers (`core/src/client.rs:904-910`) and `x-codex-turn-state` when
  present (`responses_websocket.rs:525-532`).
- Upgrade must succeed with **HTTP 101 Switching Protocols** (`responses_websocket.rs:501-506`).
- `permessage-deflate` compression is negotiated by default (`responses_websocket.rs:542-549`).
- Server upgrade-**response** headers Codex reads (all optional): `x-reasoning-included`
  (`:514`), `x-models-etag` (`:515-519`), `openai-model` (`:520-524`), `x-codex-turn-state`
  (`:525-532`).

## 4. Client → server frames (what Codex SENDS)

Envelope `ResponsesWsRequest`, serde `#[serde(tag = "type")]` (`codex-api/src/common.rs:269-277`):

| `type` | Struct | When |
|--------|--------|------|
| `response.create` | `ResponseCreateWsRequest` (`common.rs:215-240`) | each turn |
| `response.processed` | `ResponseProcessedWsRequest { response_id }` (`common.rs:242-245`) | ack after consuming a response |

- `response.create` fields: `model, instructions, previous_response_id?, input: Vec<ResponseItem>,
  tools, tool_choice, parallel_tool_calls, reasoning?, store, stream, include, service_tier?,
  prompt_cache_key?, text?, generate?, client_metadata?` (`common.rs:215-240`). It is the same
  semantic payload as the HTTP `POST /v1/responses` body.
- Sent as a single WS **Text** message (`responses_websocket.rs:782,795`).
- `previous_response_id` links multi-turn on the reused connection (`common.rs:197,221`).
- `generate: false` is a **prewarm** (open + warm the connection without an LLM request)
  (`core/src/client.rs:15-16`).

## 5. Server → client frames (what Codex EXPECTS)

- Same schema as SSE: `ResponsesStreamEvent` (`sse/responses.rs:145-158`), parsed by
  `serde_json::from_str` from each Text frame (`responses_websocket.rs:704-718`).
- Event types parsed (`sse/responses.rs:263-397`): `response.created`,
  `response.output_item.added/.done`, `response.output_text.delta`,
  `response.reasoning_summary_text.delta`, `response.reasoning_text.delta`,
  `response.reasoning_summary_part.added`, `response.custom_tool_call_input.delta`,
  `codex.rate_limits`, `response.metadata`, and the terminals below.
- **Terminal success: `response.completed`** — the ONLY success terminal; Codex breaks the loop
  on it (`responses_websocket.rs:747-750`; payload shape `sse/responses.rs:358-375`, requires
  `response.id`).
- **Error terminals:** `response.failed` / `response.incomplete` → classified `ApiError`
  (same classifier as SSE, `sse/responses.rs`). A standalone error **frame**
  `{"type":"error","status":429,"error":{…}}` is also accepted (`responses_websocket.rs:575-636`);
  `code == "websocket_connection_limit_reached"` → `ApiError::Retryable` (`:613-622`).
- **Unknown event types are silently skipped** (forward-compat, `sse/responses.rs:391-394`).

## 6. Lifecycle: close / cancel / idle / ping / errors

| Concern | Behavior | Cite |
|---------|----------|------|
| Server closes before completed | `ApiError::Stream("websocket closed by server before response.completed")` | `:762-765` |
| Stream EOF before completed | `ApiError::Stream("stream closed before response.completed")` | `:693-696` |
| Idle (per-message) timeout on recv | `ApiError::Stream("idle timeout waiting for websocket")` | `:682-684` |
| Idle timeout on send | `ApiError::Stream("idle timeout sending websocket request")` | `:793-798` |
| Server `Ping` | Codex auto-replies `Pong` (no app action) | `:93-98` |
| Binary frame | forbidden → `ApiError::Stream("unexpected binary websocket event")` | `:759-760` |
| Transport/WS error | `ApiError::Stream(err)` | `:690-691` |
| Cancel | Codex drops the stream; **no explicit close frame** — server detects socket EOF | (no send-close in source) |

## 7. Minimum server obligations (opencodex MUST)

Derived strictly from §3–§6:

1. Accept a WS **upgrade at `/v1/responses`** returning HTTP 101 (`:500-506`).
2. Parse incoming **Text** frames as `ResponsesWsRequest`; handle `response.create`
   (`common.rs:273-274`).
3. Emit at least one event, starting with `response.created` (`sse/responses.rs:307-310`).
4. Emit exactly one **`response.completed`** to terminate success (`:747-750`); emit nothing
   after it.
5. On failure, emit a classified `response.failed` (reuse 100.5 / 110 classifier).
6. Accept (may no-op) `response.processed` acks (`:219-241`).
7. Text-only frames; never send Binary (`:759-768`).
8. Tolerate client socket EOF as cancel; abort upstream work.
9. Optional but recommended upgrade-response headers: `openai-model`, `x-reasoning-included`.

## 8. Gotchas

- `response.completed` is mandatory + terminal; same invariant as the SSE bridge's RC1
  (`110/40_p0-implementation.md`) — the WS path can reuse the bridge's terminal-guarantee logic.
- Idle timeout is **per-message**, so a WS stall needs the same heartbeat strategy as RC3 — but
  note Codex auto-Pongs server **Ping** frames (`:93-98`), so a WS keep-alive can be a real
  `Ping` (cheaper than the SSE `response.heartbeat` workaround).
- Auth only at handshake — no per-frame token. opencodex's existing per-request auth must move
  to upgrade time.
- `previous_response_id` + connection reuse means the WS endpoint is **stateful per connection**
  (multiple `response.create` over one socket), unlike the stateless HTTP handler.
- `permessage-deflate` is negotiated; Bun's `ServerWebSocket` supports compression — verify it
  is enabled or that uncompressed is accepted.
