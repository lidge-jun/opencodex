# Inbound Compatibility Surfaces

Native result continuations and function-result injection follow [the mode-specific result and control contract](../transports/streaming-health.md#experimental-native-function-result-injection); this surface does not infer upstream support or alter its defaults.

Native steering follows [the shared WebSocket contract](../transports/streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

Compatibility callers retain the public Responses ingress described by the
[core module ownership](../transports/responses.md#core-module-ownership). This surface retains its existing behavior.

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged. Cursor's localized native-shell names follow the [routing-commentary guard contract](../providers/cursor.md#cursor-native-exec).

## Standalone file transcription

`src/server/audio-transcriptions.ts` owns `POST /v1/audio/transcriptions`, independently of
Responses and Chat conversion. `src/server/audio-upstream.ts` resolves explicit data-plane keys
on both listeners and substitutes stored OpenAI credentials. Direct stored-main access claims
the enclosing admission lease and derives its account header only from that stored credential;
caller-supplied account selection is never retained. Pool uses the existing sidecar account resolver. A selected
ChatGPT authentication failure never falls through to the paid OpenAI provider.

The bounded multipart input accepts one nonempty file up to 25,000,000 bytes within a 32 MiB
body, required model, and optional prompt, language and JSON/text response format. Unknown or
duplicate fields fail. Subscription requests use the compatibility identifier gpt-4o-transcribe
and send no model upstream; the keyed API also accepts gpt-4o-mini-transcribe and whisper-1.
Responses retain only text. Manual redirects, capped response reads and linked cancellation
keep credentials and audio content out of redirects, request logs and durable storage.
`tests/server/audio-transcriptions.test.ts` exercises the real ingress and synthetic upstream;
`tests/server/api-key-attribution.test.ts` uses multipart fixtures for the HTTP auth matrix.

## Streaming audio

`src/server/audio-client.ts` recognizes explicit audio keys before local legacy admission.
Browser sockets offer opencodex-audio and opencodex-key.<base64url-key>; only the public
marker is selected downstream. Invalid presented keys cannot become credential-free native calls.
`src/server/audio-dictation.ts` maps the validated desktop session.start/audio.append/session.close
protocol to ChatGPT dictation with server-owned credentials and a five-minute lifetime.
The `src/server/index.ts` byte relay retains bounded queues, handshake/session deadlines and
the account/turn lifecycle until its upstream closes. `src/server/ws-bridge.ts` carries the
in-memory callbacks and signal; handshake credentials are cleared after socket construction.

`src/server/audio-live.ts` owns external keyed GPT-Live creation and joins while the original
`src/server/live.ts` keeps the native compatibility path. `src/server/live-call-bindings.ts`
maps opaque rtc_ocx_ aliases to the creating key, provider, physical account and protocol.
Expired aliases never fall through to native joins. Reconnect resolves the recorded account
freshly; keyed provider replacement fails unless its credential digest still matches.
The registry is per server, holds at most 1024 entries for 30 minutes and is cleared on shutdown.
It does not proxy WebRTC media or execute delegation requests. Standalone Frameless defaults
to gpt-live-1-codex; gpt-live-1 is an explicit alias. Dictation and Frameless event formats remain
separate. Coverage lives in `tests/server/audio-client.test.ts`,
`tests/server/audio-dictation.test.ts` and `tests/server/live-call-bindings.test.ts`.

Translated Claude timeline reminders use the Chat adapter's
[OpenCode Go instruction ordering](../providers/chat-compat.md#opencode-go-chronological-instructions)
on its exact supported route. This is separate from trailing-notice stabilization
and from native Chat message passthrough.

Shared parsing and streaming follow the [request-copy](../transports/byte-accounting.md#request-copy-accounting) and [stream-buffer accounting](../transports/byte-accounting.md#stream-buffer-accounting) contracts. Response-attached WebSocket telemetry follows the [stage record identity contract](../transports/responses.md#passthrough-sse-stream-shapes-314).

## Chat Completions inbound native path

`POST /v1/chat/completions` sends eligible `openai-chat` routes directly to the provider's Chat
Completions endpoint. Route selection reads the raw Chat body and the native request keeps that body
as its wire source; a Responses projection is constructed only after the native route is declined
and is never converted back into Chat. Translated Codex requests inherit the
[Responses compatibility and retired-evidence policy](../transports/responses.md#responses-httpsse),
without introducing a model-name denylist at this inbound boundary. Request construction remains owned by `src/adapters/openai-chat.ts`, including model
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
The native passthrough still applies the existing model capability authority to reasoning: an
explicit empty ladder removes caller `reasoning_effort`, while an unknown ladder remains
unclassified. This guard does not alter the separate raw service-tier contract.

On the response side, the upstream `service_tier` echo (xAI Priority Processing, OpenAI fast
tier) relays to the Chat Completions caller on every delivery shape: the non-streaming body
(`responsesJsonToChatCompletion` in `src/chat/outbound.ts`), the folded stream
(`collectChatCompletion` in `src/chat/outbound.ts`), and each synthesized SSE chunk
(`jsonCompletionSse` in `src/server/chat-native-sse.ts`). An upstream that sends no
`service_tier` gets no injected key. The Responses lane already relayed the same field for
responses-wire upstreams; the responses-lane assembly for chat-wire upstreams keeps it in
attempt telemetry only.

Combo/policy routes and requests that need Responses-only hosted tools, continuation, background,
or storage semantics retain the existing Chat -> Responses -> Chat bridge.
Chat-to-Responses traffic that lands on `api.meta.ai` inherits the same 64-character tool-name
aliasing as native Responses; see [`responses.md`](../transports/responses.md).

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

### Native Chat completion lifecycle

`src/server/chat-native-sse.ts` applies the resolved `stallTimeoutSec` while waiting for upstream
progress. Nonempty text, reasoning, refusal, tool identity/arguments, and finish frames renew the
allowance; comments, role-only frames, empty deltas, and usage alone do not. Downstream backpressure
pauses this wait budget. A stall emits a Chat error with `upstream_stall_timeout` and logs 502;
the non-streaming endpoint returns HTTP 502 rather than a successful partial result.

`src/chat/outbound.ts` collects LF/CRLF, multiline data, and split UTF-8 through the shared SSE
block buffer and tracks appended output bytes incrementally. A caller cancellation before a native
terminal returns 499 / `client_cancelled`; an already accepted terminal keeps its result. Reader,
timer, turn, and translator ownership are released through the existing lifecycle.

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

The shared Responses path follows the [bounded multipart recovery contract](../subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

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

Usage consumers preserve positive incomplete-history metadata as specified in [usage accounting](../gui-and-management-api.md#usage-accounting); readable totals are not represented as a complete ledger. Upstream API-key usage follows the [physical-attempt account attribution contract](../gui-and-management-api.md#upstream-key-account-attribution), independently of subscription quota observations.

Connected CLI usage follows the [client-scoped hub usage contract](../gui-and-management-api.md#usage-accounting); local management and account data remain separate.

Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](../remote-workspace.md) owns that integration.

Listener startup diagnostics follow [the runtime lifecycle contract](../runtime.md#lifecycle); malformed optional listener blocks follow [config loading](../config.md#config-surface).
Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](../providers/openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](../gui-and-management-api.md#combo-editor-routing-quota).

Codex pool settings and their consumers follow the [reset-first ordering contract](../providers/openai-tiers.md#reset-first-account-ordering), including independent-quota fallback and preserved affinity.

Canonical Spark Lite metadata follows the final serialized model and surviving nonempty Lite tool catalog; see [Responses transport](../transports/responses.md).

Optional Codex transport-hint suppression is scoped to canonical Responses client output;
its defaults and exclusions are owned by [Responses transport](../transports/responses.md).

The provider summary default applies at Responses ingress; native Chat and Anthropic inbound preferences keep their existing handling. Raw content is never renamed to a summary. See [bridge contract](../providers/chat-compat.md).

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

Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](../catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.
Pool quota producers and account commands follow the [bounded raw-observation contract](../providers/openai-tiers.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates.

Account quota surfaces use [safe probe diagnostics](../transports/inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.

Live sideband admission and its bounded upstream handshake follow the [runtime contract](../runtime.md#live-sideband-handshake); the ordinary Responses WebSocket exchange remains separate.

Translated Chat request construction uses the [inline-image budget](../transports/streaming-health.md#translated-chat-inline-image-budget); the shared normalizer counts retained bytes even when a wire-specific drop callback keeps the image attached.

The [explicit model-capability contract](../config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Provider-scoped approval reviewer settings are projected by the [catalog owner](../catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior.

## Shared inbound Chat image recognition

`src/chat/image-parts.ts` owns which `messages[].content[]` shapes count as an image
on the Chat Completions ingress: OpenAI `image_url` in both spellings, Pi/MCP
`{type:"image", data, mimeType}`, and Anthropic-shaped `{type:"image", source}` in
base64 and url form. The translator and the native fast path both read it, because
they previously answered that question separately and disagreed: native
route-eligibility matched only `image_url`, so a text-only routed model kept a
Pi-shaped or Anthropic-shaped image body and the native whitelist passthrough
forwarded the foreign part verbatim.

Normalization is copy-on-write and lazy: replacement arrays are allocated only once a
part actually needs rewriting, so an ordinary text request walks the messages and
allocates nothing.

**Shape normalization alone does not make a tool-result image safe on the native fast
path.** A standard Chat `role: "tool"` message accepts a string or text parts, not
`image_url`, so rewriting a Pi or Anthropic tool image still leaves an image part
inside a tool message. `chatBodyCarriesToolResultImage` therefore makes such a request
ineligible for the native shortcut, and the translated openai-chat adapter owns it —
that adapter already collects tool-result images and flushes them into a following
`user` carrier after the complete paired tool-result batch. Ordinary user images and
text-only tool results keep the native fast path.

`normalizeChatImageParts` runs in `handleChatCompletionsWithBudget` immediately
after routing-body validation and before `routeModel`, so the text-only diversion in
`isNativeChatRouteEligible` and the forwarded native wire observe the same parts. It
rewrites only recognized foreign parts into `image_url` form and returns its input by
reference when nothing matched, so a body with no image — and one already in OpenAI
shape — stays byte-identical. Sibling parts, message fields and top-level body fields
are preserved; the native path is a whitelist passthrough, so an incidental deep clone
would itself be a behavior change. A remote reference is recognized and rewritten,
never fetched.

## Translated Chat control fidelity

Translated Chat ingress does not reshape schemas for Google's
[endpoint-scoped loss report](../providers/google.md#google-tool-schema-loss-reporting). The report
is produced only at the final Google adapter boundary and does not alter the ingress body.

A translated Chat turn keeps the controls the caller sent. The Chat ingress pins
`store:false` for every `openai-responses` route and strips nothing else: the
sampling and output-cap restrictions that the canonical ChatGPT backend requires are
applied at the final outgoing body in `src/adapters/openai-responses.ts`, gated on
`isCanonicalOpenAiForwardProvider`, which additionally requires `authMode: "forward"`
and the canonical base URL.

Deciding at the ingress was wrong on two axes. Seven providers share the
`openai-responses` adapter string, so a generic key gateway lost controls it
accepts; and `settledRoute` is the ingress-time route, while a combo or policy route
resolves its concrete child later, so the decision preceded knowledge of the real
target in both directions. `stripCanonicalForwardSamplingParams` returns a copy and
no-ops when none of its keys are present, so `_rawBody` stays caller-owned. The
separate forward-wide `max_output_tokens`/`metadata` sanitizer is unchanged.

An assistant turn's `reasoning_content` or `reasoning_details` is carried into the
projection as a `reasoning` input item emitted immediately before its assistant
message, matching the parser's buffer-and-prepend adjacency. Only representable
plaintext crosses: no signature, encrypted payload or provider item id is
reconstructed, because those attest to content this proxy never received. Opaque
reasoning replay across a Chat boundary remains unimplemented by design.
`presence_penalty` and `frequency_penalty` are carried too; per-model
`noPenaltyModels` opt-outs still apply at the adapter.

## Explicit reasoning disable on the Chat ingress

The Chat inbound effort allowlist accepts `none` alongside the ladder values.
`none` is the runtime's disable sentinel — `src/reasoning-effort.ts` maps it to
omitting the wire parameter, and the Pi client export maps Pi's `off` thinking level
onto it. Dropping it let a provider default re-enable reasoning the caller had
explicitly turned off, which is not neutral for the Anthropic families that think by
default and require an explicit `thinking:{type:"disabled"}` to stop.


## Media at the Chat translation boundary

The native Chat path retains provider-native file/audio blocks. When a request instead needs
Chat-to-Responses projection, `src/chat/inbound.ts` rejects recognized audio/file content
before it can become empty text, regardless of message role. Legacy `function`-role images
also return an explicit error; their call/result pairing is not implemented by this projection.
Modern `tool` images continue through the existing following-user carrier. These errors state
an OpenCodex conversion limit, not a provider capability claim. Final Responses-to-adapter
admission follows the [registry contract](../adapters/registry.md#untranslated-input-media).
Canonical Responses identity sanitation and narrowly scoped pre-output combo recovery follow [request-local target compatibility](../runtime.md#request-local-target-compatibility); other adapter contracts remain unchanged.

Shared response-log retention and native SSE inspection pacing follow the [bounded inspection contract](../transports/byte-accounting.md#response-log-inspection); other subsystem behavior remains unchanged.

Native steering retains fixed phase deadlines and reconciled replay output; see the [steering stability contract](../transports/streaming-health.md#steering-deadlines-and-replay-completeness).

Native steering generation overrides, explicit public-API eligibility and the consent-gated wire probe follow the [shared control contract](../transports/streaming-health.md#steering-settings-public-api-and-diagnostic-probe); this owner does not change routing or execute diagnostic tools.

Unicode pattern normalization uses [copy-on-write traversal](../transports/byte-accounting.md#unicode-pattern-normalization) while preserving the existing schema and wire semantics.

Dashboard Fast-row persistence and client refresh follow the [Fast selector rows setting contract](../gui-and-management-api.md#fast-selector-rows-setting).

The [compaction routing override](../transports/responses.md#compaction-routing-overrides) requires original Responses ingress; translated Chat and Messages calls retain their own routing.
