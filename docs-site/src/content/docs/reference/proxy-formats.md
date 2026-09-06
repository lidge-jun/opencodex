---
title: Proxy API Formats
description: Wire-level reference for the Responses, Chat Completions, Anthropic Messages, model catalog, WebSocket, realtime, and compaction surfaces.
---

opencodex presents one local proxy in several client dialects. A Codex client can speak the
Responses API, an OpenAI-compatible app can speak Chat Completions, and Claude Code can speak
Anthropic Messages without requiring every upstream provider to implement every format.

The normal translation path is:

```text
client dialect → internal Responses model → provider adapter → provider wire format
provider events → internal adapter events → client dialect
```

The Responses representation is the center of the bridge. Native-compatible routes may skip parts
of the translation and pass a request through, but authentication, routing, admission control, and
response safety still happen at the proxy boundary. Configure the listener and admission keys in
[Configuration](/reference/configuration/); use [Combos](/guides/combos/) when one public model id
should select among several targets.

## Endpoint overview

| Client surface | Endpoint | Successful non-stream result | Successful stream or socket result |
| --- | --- | --- | --- |
| OpenAI Responses | `POST /v1/responses` | Responses JSON | Responses SSE, or Responses JSON text frames over WebSocket |
| OpenAI Chat Completions | `POST /v1/chat/completions` | `chat.completion` JSON | `chat.completion.chunk` SSE ending in `[DONE]` |
| Anthropic Messages | `POST /v1/messages` | Anthropic `message` JSON | Anthropic Messages SSE |
| Anthropic token count | `POST /v1/messages/count_tokens` | `{ "input_tokens": number }` | Not applicable |
| Model discovery | `GET /v1/models` | Catalog or explicit Desktop snapshot | Not applicable |
| Voice and Realtime | `POST /v1/live`, `POST /v1/realtime/calls` | Relayed call-creation response | A separate sideband WebSocket relays frames in both directions |
| Responses compaction | `POST /v1/responses/compact` | Replacement-history JSON | Not applicable |

## `POST /v1/responses`

This is the native opencodex data-plane shape. The request body must be a JSON object with a
non-empty `model`. `input` may be a string or an array of Responses items.

### Accepted request fields

| Area | Accepted shape |
| --- | --- |
| Model and input | Required non-empty `model`; optional string `input` or an item array |
| Message items | `user`, `developer`, `system`, and `assistant` messages; string content or typed content blocks appropriate to the role |
| Content blocks | Text, input images, input files, output text, refusals, and reasoning summary/text blocks where their parent item permits them |
| Tool history | `function_call`, `function_call_output`, `custom_tool_call`, and `custom_tool_call_output` items |
| Tools | Function tools plus loose built-in or hosted tool entries; `tool_choice` accepts `auto`, `none`, `required`, named function/custom choices, hosted choices, or `allowed_tools` |
| Reasoning | `reasoning.effort` and `reasoning.summary` (`auto`, `concise`, `detailed`, or `none`) |
| Continuation and caching | `previous_response_id`, `store`, and `prompt_cache_key` |
| Generation controls | `max_output_tokens`, `temperature`, `top_p`, `stop`, `presence_penalty`, and `frequency_penalty` |
| Service and execution | `stream`, `service_tier`, `parallel_tool_calls`, `instructions`, `metadata`, and `user` |
| Extended Responses fields | `background`, `include`, `prompt`, `text`, and `truncation` are accepted for compatible routes |

Unknown item types are accepted as loose typed items for forward compatibility. Translated adapters
handle only the item types they recognize, and may reject a feature their provider cannot represent.
On the canonical ChatGPT Codex forward route, text-only `system` input messages are folded into
top-level `instructions`, and `truncation` is removed because that destination rejects both public
Responses shapes. Other Responses destinations preserve them.
The same canonical boundary removes nested client-only `prompt_cache_breakpoint` markers and drops
`item_reference` entries only on `store: false` continuations; tool call/result pairing is unchanged.

Image file IDs are provider-scoped references, not portable image bytes. Responses passthrough
retains them; translating adapters receive an `[image: file_id]` text marker for file-only image
parts in messages or function/custom tool outputs. Use an image URL or base64 data URL when the
translated model needs to see the image. Hosted `computer_call_output` items require a Responses
passthrough route; translated routes return HTTP 400 instead of silently dropping the screenshot.
For a screenshot observation without hosted computer-tool semantics, use a user `input_image`.

### JSON and SSE output

With `stream: true`, the response is `text/event-stream`. The bridge emits Responses events such as
`response.created`, output-item and text/tool deltas, and exactly one terminal
`response.completed`, `response.failed`, or `response.incomplete` event. A normal stream ends with
`data: [DONE]`.

With `stream: false` or no `stream`, the same adapter events are collected into one Responses JSON
object. Both forms preserve the selected model, output items, terminal status, and usage.

For native HTTP/SSE passthrough, a client cancellation without an observed upstream terminal is
logged as `499` with `closeReason: "client_cancel"` and does not penalize the account pool.
This applies to both tee inspection and eager relay, including Windows rewrite traffic,
even when the upstream read rejects before the response-body cancellation hook runs.
A terminal captured during the bounded post-disconnect drain retains its actual outcome.

If native passthrough rewriting fails, including when it exceeds the translation
buffer budget, the relay reports the failure without waiting for upstream inspection
to finish. It cancels the upstream work and emits `response.failed` followed by
`data: [DONE]`; a budget overflow uses the `translation_buffer_limit` error code.

Client-facing Responses SSE frames are limited to 4 MiB per frame, measured in raw bytes before the
SSE block delimiter. On HTTP, an unterminated upstream frame that exceeds the limit fails closed
with a synthetic `response.failed` event followed by `data: [DONE]`. On the Responses WebSocket
bridge, the same condition emits a 502 `websocket_protocol_error` and cancels the upstream reader.
A complete Responses terminal frame is authoritative: oversized or malformed trailing bytes after
that terminal are dropped rather than replacing the completed turn with a transport failure.

:::note
For native passthrough, a Responses terminal event is authoritative. A premature `data: [DONE]` is
held until that event. On the ordinary native path, a clean HTTP 200 EOF without a parsed terminal
emits one `response.incomplete` with `incomplete_details.reason: "adapter_eof"`, followed by one
`data: [DONE]`; syntactically valid delimiter-less terminal JSON is accepted exactly once, while
malformed or truncated JSON remains incomplete. For providers opted into model-scoped terminal
repair, unframed terminal-like suffixes and a premature `data: [DONE]` at EOF fail closed with
`missing_terminal_event` when no complete lifecycle candidate can be promoted; a complete candidate
is promoted to `response.completed`. High-confidence `cyber_policy`
terminal shapes normalize to `response.failed` with `error.code: "cyber_policy"` for semantic
logging/accounting (status 400), while an already-started streamed HTTP response remains 200. This
committed-request boundary does not retry or replay and does not resolve
[#2423](https://github.com/lidge-jun/opencodex/issues/2423) or
[#2486](https://github.com/lidge-jun/opencodex/issues/2486).
:::

For canonical ChatGPT forward streaming, stable Bun 1.4.0 or newer may transparently use
Codex's upstream WebSocket transport. Bundled Bun 1.3.14, prereleases, and unverifiable runtime
identities use HTTP/SSE. The upstream WS adapter keeps the same downstream SSE contract, caps both
the raw JSON frame and its SSE envelope at 4 MiB, and closes the upstream when its 8 MiB byte queue
would overflow. That overflow emits a terminal downstream `response.failed` event followed by
`[DONE]`.

The upstream WebSocket checks `NO_PROXY`/`no_proxy` first. Otherwise it uses the first non-empty
`HTTPS_PROXY`, `https_proxy`, `ALL_PROXY`, or `all_proxy` value; `HTTP_PROXY` alone does not proxy a
WSS connection. HTTP and HTTPS proxy URLs are passed to Bun. If the selected value is invalid or
uses an unsupported protocol, opencodex skips the WebSocket attempt and uses HTTP/SSE instead of
dialing the upstream directly.

These rules belong to the upstream WebSocket transport, independently of the selected provider
adapter. HTTP fetch-based Responses requests, including SSE fallback, use Bun's HTTP proxy rules
and do not use `ALL_PROXY`. `config.proxy` fills missing `HTTP_PROXY`/`HTTPS_PROXY` values; the
resulting scheme-specific value also takes precedence over an existing `ALL_PROXY` for WebSocket.
For an HTTPS upstream that requires a proxy, set `HTTPS_PROXY` or `config.proxy`; `HTTP_PROXY`
alone leaves both WSS and its HTTPS fallback without a scheme-matched proxy.

Every terminal Responses usage object includes both detail objects, even when the provider did not
report those details:

```json
{
  "input_tokens": 0,
  "output_tokens": 0,
  "total_tokens": 0,
  "input_tokens_details": { "cached_tokens": 0 },
  "output_tokens_details": { "reasoning_tokens": 0 }
}
```

When available, `input_tokens_details` can also include `cache_write_tokens`. The always-present
detail objects are a compatibility guarantee for strict Responses clients; zero can mean "not
reported," not necessarily "the provider performed no such work."

### Correlating a response with its request log

Every admitted HTTP Responses reply carries an `x-opencodex-request-id` header holding a
proxy-generated id of the form `ocx-<32 hex>`. It is the key that ties a response to its row in
the request log and in usage reporting.

The proxy always generates this value and overwrites any id supplied by the caller or returned by
the upstream, so it is unique to this proxy and safe to trust as a correlation key. The header is
named in `Access-Control-Expose-Headers`, which is what lets browser JavaScript read it
cross-origin — a custom `x-` header is otherwise invisible to `response.headers.get()` even when
it is on the wire.

Responses rejected at authentication or origin admission never reach this wrapper and carry no id,
so a missing header means the request was refused before it was logged.

### WebSocket upgrade on the same path

When `websockets` is enabled, a client may upgrade `/v1/responses` instead of opening an HTTP POST.
Authentication and origin admission happen during the WebSocket handshake. They are not repeated
inside each frame.

This client-facing upgrade is separate from the transparent upstream ChatGPT WebSocket selection
described above; the `websockets` setting controls only the client-facing endpoint.

The client sends JSON text frames:

```json
{
  "type": "response.create",
  "model": "provider/model",
  "input": "Hello",
  "tools": [],
  "generate": true
}
```

Everything except `type` becomes the Responses request body, and the proxy forces streaming for the
turn. A new `response.create` supersedes and cancels the previous turn on that socket.
`response.processed` is accepted as a no-op acknowledgement. Unparseable or unrelated frame types
are ignored.

Server frames are JSON text frames. Successful streamed output uses the same JSON payloads that
would appear in SSE `data:` lines, without the SSE envelope or `[DONE]`. A non-streaming internal
result is reframed as `response.created`, zero or more `response.output_item.done` frames, then a
terminal frame. Errors use this envelope:

```json
{
  "type": "error",
  "status": 502,
  "error": {
    "type": "upstream_error",
    "message": "..."
  },
  "headers": {}
}
```

A warmup frame with `generate: false` does not call an upstream. It returns a synthetic
`response.created` followed by `response.completed`, both with an empty response id and no output.

:::note
When WebSockets are disabled, an upgrade attempt receives HTTP 426 with code
`upgrade_required`. Codex treats that handshake result as a signal to fall back to HTTP for the
session. It is not a failed model turn.
:::

## `POST /v1/chat/completions`

This endpoint accepts OpenAI-compatible Chat Completions requests with a required `model` and a
non-empty `messages` array. It translates system, user, assistant, and tool messages into internal
Responses items; translates function tools, tool choice, images, reasoning effort, and supported
response formats; runs the normal Responses routing pipeline; then translates the result back.

Image URLs and base64 data URLs use Chat `image_url` content parts. Translation preserves
supported `detail` values (`auto`, `low`, `high`). On translated routes, OpenCodex also accepts
image-bearing tool-result arrays as a compatibility extension: Responses routes retain structured
output, while the `openai-chat` adapter sends tool images in a following user message because Chat
tool content is text-only. Other downstream adapters own provider-specific placement. Plain text
results remain strings. Native passthrough follows its upstream contract; image support still depends
on the selected model and provider configuration.

Reasoning is part of that translation. `reasoning_effort` (or `reasoning.effort`) becomes
internal `reasoning.effort`. Because the Responses parser hides thinking unless
`reasoning.summary` is set and is not `none`, Chat Completions requests that ask for an
effort default to `reasoning.summary: "auto"` so thinking streams back as
`delta.reasoning_content`. Clients can still hide traces with `include_reasoning: false` or
`reasoning.summary: "none"`. An explicit `reasoning.summary` of `auto`, `concise`,
`detailed`, or `none` wins over `include_reasoning`.

Structured output is part of that translation: `response_format` with `json_object` or
`json_schema` is forwarded to routed `openai-chat` models. On `POST /v1/responses` the
equivalent request field is `text.format`: native Responses routes preserve it in the raw
Responses body, and it is translated to `response_format` when the model routes to an
`openai-chat` provider. A model listed in the provider's `noStructuredOutputModels` omits
`response_format` on that chat wire; sibling models keep the translation. Unclassified backends
receive the field and return their own error instead of the proxy guessing their capability.

Non-streaming output has `object: "chat.completion"`. Streaming output uses SSE objects with
`object: "chat.completion.chunk"`, choice deltas, a terminal choice with `finish_reason`, and
`data: [DONE]`. Tool-call and usage information are translated back where the source events carry
them.

If a streaming Chat request receives a complete JSON Responses result upstream, the proxy
synthesizes SSE from the converted completion. It preserves answer and reasoning content,
function tool calls (with a separate stream `index` for each call), usage, and the converted
`finish_reason`, including `tool_calls` and `length`. This fallback delivers the completed result
in chunks; it cannot provide token-by-token delivery before the upstream JSON response arrives.
It does not issue an additional inference request. An incomplete response caused by the output
token limit or content filtering retains `length` or `content_filter`, even if it includes tool
output. Other incomplete boundaries return an upstream error instead of claiming a normal finish.

Because the internal execution path is Responses-based, a provider adapter can impose a narrower
feature set. For example, a request feature that cannot be represented by the selected adapter is
returned as an error instead of silently changing its meaning.

## `POST /v1/messages` and `count_tokens`

These endpoints speak the Anthropic Messages dialect used by Claude Code and compatible clients.
Most requests are translated to Responses, routed normally, then translated back to Anthropic JSON
or Anthropic SSE.

Base64 and URL image sources are translated in user messages and nested tool results. File-backed
images (`source.type: "file"`) require native Anthropic passthrough; translated routes return a
fixed HTTP 400 error asking for base64 or URL input. OpenCodex does not resolve another provider's
file storage or upload the referenced image on the caller's behalf.

When replay history contains an image-bearing tool result without its adjacent call, the
Anthropic and Command Code adapters retain the image in a provenance-labeled user carrier rather
than embedding its bytes in prompt text. They do not invent a successful tool call. Results for
valid pending calls still precede these carriers, preserving the upstream pairing contract.

For Cursor external models, data-URL screenshots in the active trailing tool-result batch are
attached to the continuation request. The existing 12-image active-attachment limit applies to
the whole batch. Bounded source labels remain beside the attachments even if older history is
pruned. Native Composer/MCP handling, historical-image recall, and remote-URL omission policy
are unchanged; this does not promise every model can see every image source.

Native Anthropic passthrough is eligible only when all of these are true:

- native passthrough has not been disabled in Claude Code configuration;
- the requested model begins with `claude` or `anthropic`;
- the request carries a native Anthropic bearer or `x-api-key` credential;
- on a non-loopback listener, the request also carries valid proxy admission only in
  `x-opencodex-api-key`; and
- no configured alias or model map claims that model id for a routed target.

An eligible request is forwarded in the Anthropic dialect so native beta headers, thinking
signatures, and subscription identity remain end to end. Otherwise it takes the Responses
round-trip.

The dedicated admission header is never forwarded. Proxy admission secrets found in
`Authorization` or `x-api-key` are also removed; a separate genuine Anthropic credential is
preserved. Ambiguous comma-joined credential headers fail closed instead of being forwarded.

`POST /v1/messages/count_tokens` follows the same model resolution and passthrough decision. A
native-eligible request is forwarded to Anthropic's count endpoint. Other requests use the local
documented estimate over system content, messages, and tools and return:

```json
{ "input_tokens": 123 }
```

An unresolved date-shaped Desktop ID can also be a genuine native model missing from discovery.
Messages and count-tokens return HTTP 503 with the fixed `desktop_model_mapping_unavailable` error when the available
evidence cannot resolve that ID; this does not establish that the model is invalid. Unknown legacy
hash aliases still return HTTP 400. Neither case strips the date or falls back to another route.
Known IDs, registered mappings and exact `modelMap` matches keep their existing behavior, including
recognized real native IDs. Refresh model discovery or reapply the connected hub profile before
trying again; retrying alone does not guarantee resolution.

## `GET /v1/models`

Without `format=desktop-config`, the ordinary catalog contracts are:

| Contract | Trigger | Top-level shape | Model-id behavior |
| --- | --- | --- | --- |
| Anthropic model list | `anthropic-version` header or `?flavor=anthropic`, without `client_version` | `{ "data": [...] }` with Anthropic model-info entries | Claude Code receives readable ids; Desktop can receive its profile-specific alias family |
| Codex catalog | `client_version` query parameter | `{ "models": [...] }` | Native and routed entries carry the richer Codex catalog fields, visibility, effort, WebSocket, and multi-agent metadata |
| Plain OpenAI list | Neither trigger | `{ "object": "list", "data": [...] }` | Visible native ids are bare; routed ids are aliases or `provider/model` |

### Desktop configuration snapshot

`GET /v1/models?ids=desktop&format=desktop-config` explicitly selects the Desktop snapshot,
independently of user-agent detection. The response is `{ "version": 1, "models": [...] }`
with `Cache-Control: no-store`. The connected client sends `Accept: application/json`,
`anthropic-version: 2023-06-01` and its existing data credential; no admin token or profile
upload is involved. Entries are the hub-issued Desktop configuration models, not Codex catalog rows.

Combining this format with `ids=cli` or any `client_version` returns HTTP 400. Without the
format selector, the ordinary contracts above remain unchanged. When Claude is disabled,
the snapshot is `{ "version": 1, "models": [] }`; connected Desktop apply treats this as
unavailable and does not write a replacement profile. Old hubs returning an ordinary catalog
instead of version 1 are unsupported; the client does not fall back to locally generated IDs.

The snapshot remains a read-only model-list contract; it is not a key-rotation or profile-upload
API. Connected Desktop key migration, recovery and disconnect operate through the existing client
lifecycle. Rotation preserves model entries and selections; CLI `rotation` distinguishes
`committed` from `rolled_back`. Disconnect restores owned settings or reports a known-legacy
standard fallback, preserving user fields and later valid selections. Conflicts or incomplete
recovery prevent a completion claim. Restart Desktop to load disk changes; disconnect does not
automatically revoke the hub key. See [Claude Desktop lifecycle](/guides/claude-code/).
Thinking replay and prompt-cache work remain separate in [#3719](https://github.com/lidge-jun/opencodex/issues/3719).

## `POST /v1/live` and Realtime sideband

`POST /v1/live` accepts the ChatGPT/Codex App Frameless call-creation surface.
`POST /v1/realtime/calls` accepts the OpenAI Realtime call-creation surface. opencodex selects an
eligible OpenAI-family route, normalizes the call-creation request for the upstream authentication
mode, and relays the bounded response.

After call creation, clients may join a sideband WebSocket using any supported inbound form:

- `/v1/live/{callId}`
- `/v1/realtime/calls/{callId}`
- `/v1/realtime?call_id={callId}`

The proxy normalizes the upstream join URL and then transparently relays text and binary frames in
both directions. Client protocol headers are preserved while upstream authentication remains
proxy-owned.

Call creation and the sideband join must run under the same OpenAI account, or the join is refused
upstream (`404`). Both legs carry Codex's `session-id` and `thread-id` headers; in Pool mode the
account choice is bound to that pair (process-local), so a join that reaches the proxy reuses the
account that created the call, while Direct mode forwards the caller's current bearer on both legs.
The relayed client headers are exactly `openai-alpha`, `x-session-id`, `session-id`, `thread-id`,
`originator`, and `x-oai-attestation` (`LIVE_CLIENT_PROTOCOL_HEADERS` in `src/server/live.ts`);
`Authorization` and the ChatGPT account id are proxy-owned on ChatGPT-backed routes (Pool replaces
them with the stored account, Direct forwards the validated caller bearer) and an API-key provider
gets its own bearer. Codex only sends the join to the proxy when `experimental_realtime_ws_base_url`
points at it; `ocx start` injects that key next to `openai_base_url` (see
[Codex integration](/guides/codex-integration/)).

## `POST /v1/responses/compact`

Compaction returns replacement history for clients that need to shorten a long Responses
conversation.

| Route type | Behavior |
| --- | --- |
| Canonical ChatGPT or official OpenAI route | Forwards the request to the native `/responses/compact` endpoint with the resolved account and model authentication |
| Other routed model | Runs an internal, non-streaming, no-tools compaction turn with a `compaction_trigger`; requires exactly one synthetic `compaction` item whose `encrypted_content` is an `ocx1:` envelope; decodes that summary into v1 replacement history |

Codex names a bare OpenAI-family model (for example `gpt-5.6-sol`) for its compaction turns
regardless of which provider the operator routes ordinary turns to. Ordinary requests reserve
such ids for the canonical `openai` provider. On the compaction surface only — `POST
/v1/responses/compact` and a `POST /v1/responses` turn carrying a `compaction_trigger` — a bare
native model with no enabled canonical `openai` provider falls back to the configured
`defaultProvider` as the summarizer instead of returning 404. The fallback applies only when the
default provider is enabled and is not itself an OpenAI-family entry; account-qualified selectors
such as `side/gpt-5.6-sol` still fail closed. The proxy logs one notice per provider when this
fallback engages. Configurations with an enabled canonical `openai` provider are unchanged.

Native compact responses are buffered with a 32 MiB maximum, including responses whose declared
`Content-Length` already exceeds the limit. The compact-specific failures include:

| Status | Type or code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request_error` | Invalid JSON/body shape or missing model |
| 404 | `invalid_request_error` | The requested model cannot be routed |
| 499 | `client_cancelled` | The client cancelled while forwarding or buffering |
| 502 | `compact_response_too_large` | Native compact output exceeded 32 MiB |
| 502 | `upstream_error` | Connection, read, or synthetic compaction turn failure |
| 502 | `invalid_response_error` | The synthetic turn did not produce exactly one valid, non-empty `ocx1:` compaction item |

## Authentication matrix

On a loopback-only bind, data-plane admission does not require a configured key. On a remote bind,
use the matrix below. “Dedicated” means `X-OpenCodex-API-Key`; the other columns mean
`Authorization: Bearer ...` and `x-api-key`.

| Surface | Dedicated | Bearer | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` HTTP and WebSocket | Required | Rejected for proxy admission | Rejected |
| `/v1/responses/compact` | Required | Rejected for proxy admission | Rejected |
| `/v1/chat/completions` | Required | Rejected for proxy admission | Rejected |
| `/v1/messages` and `/v1/messages/count_tokens` | Accepted | Accepted | Accepted |
| `/v1/models` | Accepted | Accepted | Accepted |
| `/v1/live`, `/v1/realtime/calls`, and sideband joins | Accepted | Accepted | Accepted |

Responses-family and Chat requests reserve `Authorization` for provider or Codex Direct
passthrough, so a remote proxy key must use the dedicated header. Messages and Realtime surfaces
need broader client compatibility and therefore accept all three forms.

:::caution
Data-plane keys are not management credentials. The management API uses a separate admin secret;
see [Management API](/reference/management-api/). Never reuse one secret for both planes.
:::

## Common error vocabulary

Errors use the client dialect's envelope where needed, but these status/code meanings are stable:

| Status | Type or code | Meaning |
| --- | --- | --- |
| 401 | `authentication_error` | A required proxy admission credential is missing or invalid |
| 403 | `origin_rejected` | A Responses/OpenAI data-plane request or WebSocket upgrade came from a disallowed origin |
| 503 | `combo_unavailable` | Every target in the selected combo is unavailable, in cooldown, disabled, or otherwise ineligible |
| 400 | `unreadable_encrypted_agent_task` | An encrypted v2 worker task has no eligible canonical ChatGPT target or direct key-auth Responses target explicitly trusted with `allowEncryptedV2AgentTasks: true` that can consume it |
| 426 | `upgrade_required` | The Responses WebSocket transport is disabled or the upgrade failed; use HTTP |

Anthropic-origin failures are rendered in Anthropic's error envelope, so the origin rejection is a
403 `permission_error` on that dialect rather than the OpenAI-style `origin_rejected` body.

## Encrypted-content hygiene

The proxy treats genuine backend ciphertext as opaque. Structurally valid ciphertext is preserved
byte for byte: opencodex does not decrypt it, translate its contents, or re-encrypt it for another
provider.

Some agent hooks have historically placed plaintext control text in an `encrypted_content` slot.
For compatibility, the proxy separates that plaintext into text parts while retaining any
structurally valid Fernet runs unchanged. If an `agent_message` loses all encrypted parts during
that repair, it becomes a normal user message. If a current v2 task remains genuinely encrypted
but the selected routed target cannot read native ChatGPT ciphertext, opencodex fails with
`unreadable_encrypted_agent_task` instead of sending unreadable bytes to that provider. See
[Sub-agent Surface](/guides/sub-agent-surface/) for the client behavior around worker tasks.
