# Inbound Compatibility Surfaces

## Chat Completions inbound native path

`POST /v1/chat/completions` sends eligible `openai-chat` routes directly to the provider's Chat
Completions endpoint. Route selection reads the raw Chat body and the native request keeps that body
as its wire source; a Responses projection is constructed only after the native route is declined
and is never converted back into Chat. Request construction remains owned by `src/adapters/openai-chat.ts`, including model
normalization, credential and provider headers, capability-specific fields, and the send URL: the
canonical `openaiChatCompletionsUrl()` path, or `chatCompletionsPath` when the provider declares one.
That field is the `openai-chat` mirror of `responsesPath` and exists because a per-model wire
override swaps the adapter without touching `baseUrl`, so an upstream serving the two wires under
different prefixes cannot be reached by the swap alone. The passthrough builder uses an explicit Chat-field whitelist so
messages (including `name` and separate `system`/`developer` entries), Chat token controls,
sampling/logprob fields, caller identity/metadata, and caller stream options retain their wire
shape. For streams, caller `stream_options` are merged with mandatory `include_usage: true`. On
the native passthrough there is no canonical Fast injection and no wire mapping: every caller
`service_tier` — canonical or foreign — is forwarded raw and only under `chatServiceTier: true`,
and `fastMode` injects nothing here. Resolved-Fast-policy injection applies only to routes that
take the Chat -> Responses -> Chat bridge below. `parallel_tool_calls` is emitted only for providers opted into
parallel tools (or pinned false by the existing provider opt-out contract).
Combo/policy routes and requests that need Responses-only hosted tools, continuation, background,
or storage semantics retain the existing Chat -> Responses -> Chat bridge.

The direct SSE relay accepts CRLF and arbitrary transport chunk boundaries while retaining at most
one bounded event. EOF with an unterminated event and an event above the translator limit are typed
upstream failures, never successful partial completions. Provider-controlled structured error
messages are redacted before either JSON or SSE reaches the client. The native path uses the same
request-attempt logging, reset retry, same-key 429 replay, key rotation, usage extraction, and
request-signal cancellation contracts as routed Responses transport. Because
`src/server/chat-completions.ts` never enters Responses core,
`src/server/chat-native.ts` repeats the pre-dispatch `selectProactiveApiKeyTransport`
call before it binds the adapter; the pick remains inert unless a strategy is configured
and the committed key is cooling. See [`responses.md`](../transports/responses.md).

## Chat conversation identity forwarding

`src/server/chat-completions.ts` preserves caller `prompt_cache_key` on the Chat-to-Responses
bridge. Canonical ChatGPT Responses forwarding preserves `session_id`, `session-id`, `thread-id`
and per-request `x-client-request-id` under their original names. Missing conversation identity
stays missing; a shared prefix/cache key is not converted into a session. The direct-mode
outbound contract is covered by `tests/responses/chat-conversation-affinity.test.ts`.
This transport contract does not prove a client's emission, Pool selection stability or cache hits.

## Chat streaming client with a JSON upstream result

The translated inbound path in `src/server/chat-completions.ts` may receive a complete JSON
Responses result even when the Chat client requested SSE. Its synthetic stream reuses
`responsesJsonToChatCompletion` as the semantic authority: converted text, reasoning, available
refusal content, tool calls, finish reason, and usage must survive this final delivery conversion.
Tool calls gain their array-order stream `index`; the stream retains one assistant-role frame,
one terminal choice, and one `[DONE]`. Both native and translated JSON fallbacks share
`jsonCompletionSse`; its temporary frame strings and final body ownership are charged to the
existing translator budget. Known incomplete limits take precedence over tool finish reasons;
unmapped incomplete boundaries remain errors. The existing response-body lifecycle owns translation-budget
release on consumption or cancellation. Actual upstream SSE and native Chat bypass this fallback.

> Decision record: [ADR-0062](../decisions/ADR-0062-chat-streaming-client-with-a-json-upstream-resul.md)

### Chat refusal projection

`src/chat/outbound.ts` keeps Responses refusal parts separate from ordinary content. JSON output
and the stream collector expose nullable `message.refusal`; `jsonCompletionSse` preserves it as
`delta.refusal`, while the native SSE relay remains opaque. The translated live stream keys refusal
state by raw `output_index` / `content_index`, validates present item IDs as correlation constraints,
and emits buffered parts in that order only at a valid completed/incomplete terminal. Deltas append;
equal, empty, absent, and shorter-prefix snapshots preserve existing text; extending snapshots add
only new text. Non-string or contradictory snapshots fail with a content-free typed error.

The existing turn budget accounts for refusal text and map metadata, including empty entries, and
releases that state on terminal, failure, or cancellation. Pending role/tool/refusal/finish/`[DONE]`
frames form one terminal batch: all serialized strings and encoded frames must be admitted before
any batch frame is enqueued. Admission failure releases the batch and refusal state, cancels upstream,
and emits only the bounded overflow error. Collector processing failures cancel their reader before
releasing its lock, so upstream translation cannot continue after failed JSON collection. The outer
response finalizer continues to own retained response bytes. These are projection rules, not new
refusal policy or changes to ordinary content/tool semantics.

## MiniMax Anthropic-compatible clients

The MiniMax platform CLI's text resource posts Anthropic Messages to
`/anthropic/v1/messages`. `ocx mmx` adapts that hard-coded client path with a temporary
loopback bridge instead of adding another server route. The bridge accepts only POSTs to the
messages and count-tokens paths, rewrites them to the existing `/v1/messages` data plane,
preserves the query and streaming body, strips all incoming credential headers, and pins the
public loopback placeholder. It stops as soon as the MMX child exits, so the server's
`AUTH_MATRIX` and authentication surface remain unchanged.

`ocx mmx` exposes only the text resource because the other MMX resources use MiniMax-specific
image, video, speech, music, vision, search, quota and file endpoints. The launcher isolates
`~/.mmx` credentials behind a temporary config, removes ambient proxy variables so loopback
traffic cannot be sent off-machine, owns the temporary bridge lifecycle, and refuses
destination, region and credential overrides. It is
loopback-only because MMX cannot carry the dedicated remote-admission header. MiniMax Code uses
the separate reversible `custom_provider.opencodex` file integration and is likewise
loopback-only; its generated block never changes `defaultModel`. Each generated MCode model
copies an authoritative catalog context window into `limit.context` and a nonempty canonical
reasoning ladder into `thinking.effortOptions`. Missing capabilities stay absent instead of
falling back to OpenCodex guesses, and the integration does not write the removed
`thinking.effort` / `defaultEffort` fields because MCode owns the active effort per session.

Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](../providers/openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](../gui-and-management-api.md#combo-editor-routing-quota).

## Claude affinity at final Go dispatch

`src/server/claude-messages.ts` carries validated conversation affinity privately through
Responses options. Configured Go headers win; otherwise explicit session/thread identity,
then an explicit Go header, then valid Claude metadata, then the original request-scoped
allocation supplies the lane. `src/server/responses/core.ts` applies it only at the final
canonical Go transport, including combo selection and failover. No Go-only replay header
reaches non-Go destinations. Shared system cache keys never become conversation identity.
The request-scoped fallback is stable across retries and distinct across client requests.

Claude metadata also supplies a private native-session value. Only the final canonical ChatGPT
attempt receives it, in copied forwarding headers; an explicit underscore session, hyphenated
session or thread header suppresses synthesis. Refresh and alternate-account retries retain
that value. Original request headers stay unchanged so policy fallback cannot promote a generated
native identifier into a noncanonical replay. Go preliminary selection does not suppress the
final native affinity, and shared-system keys do not provide either conversation value.

## Opt-in Claude instruction stabilization

`src/claude/inbound.ts` reads only literal `claudeCode.stabilizePromptCache: true` from
its existing configuration argument. The default is off for every translated Messages caller.
`src/claude/inbound-cache-stabilize.ts` relocates only exact single-line trailing unfenced harness notices
into a trailing user input message; unmatched and fenced text is preserved, including an open
fence through EOF. Native passthrough never enters this translator. Without opt-in the original
system-parts cache-key derivation remains unchanged; with opt-in the metadata-less key uses
stabilized instructions. Metadata-derived keys retain their existing derivation. This configuration
changes prompt roles, not conversation identity, and cannot guarantee upstream cache reuse.

Instruction notice extraction scans fence ranges once and walks original lines backwards with
a decreasing cursor. It accepts exactly one ASCII space inside the token notice, preserves
unmatched prefix bytes, and does not repeatedly scan or copy shrinking prompt prefixes.
