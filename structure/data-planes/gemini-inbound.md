# Gemini-Compatible Inbound

Gemini clients (the google-genai SDK with a custom base URL, `agy` with its `genai` gateway wire
protocol, `GOOGLE_GEMINI_BASE_URL`) can use configured provider routes through the Gemini REST
shape. Like the [Ollama inbound](ollama-inbound.md) it is a translation onto the
[Chat Completions inbound](inbound-compat.md) path by default. The default-off
[Antigravity OAuth passthrough](gemini-native.md) runs after the same admission for eligible
`/v1beta` generation. Eligible native wire aliases augment the model catalog when enabled.

`src/server/gemini-native-paths.ts` classifies a path: `GET /v1beta/models`,
`GET /v1beta/models/{model}`, and `POST /v1beta/models/{model}:{method}` or
`POST /v1/models/{model}:{method}` for `generateContent`, `streamGenerateContent`, `countTokens`,
`embedContent` and `batchEmbedContents`. The model may contain `/` (a `provider/model` selector),
may be URL-encoded, and may carry a doubled `models/` prefix. `/v1/` counts only with a known
`:method`, so OpenCodex's own `GET /v1/models` and every other `/v1/*` route are untouched. A wrong
HTTP method on a recognised path is a native 405 with `Allow`. `src/server/index/gemini-routes.ts`
matches in `serve-options.ts` next to the Ollama arm. The routes are data plane only:
`managementIngressRouteAllowed` in `src/server/index.ts` denies them and all of `/v1beta/`, and the
package-tree fence answers them in the Gemini error shape. The unauthenticated data-loopback
allowlist admits each path with its own HTTP method only (a wrong method is a 404 there, not the
405), because `ocx connect agy` points the CLI at that socket; admission still comes from the
receiving listener's policy, as for the chat wire. OPTIONS takes data-plane origin policy.
The gateway serves these routes by default. An explicit false or malformed Gemini surface setting
returns a Gemini-shaped 403 for supported methods before credential handling, turn admission or
body reads. `PATCH /api/protocols/settings` writes `apiSurfaces.gemini.enabled` from the boolean
`geminiEnabled`. `GET /api/protocols` reports `geminiSurface` alongside the three planning
surfaces. `GET /api/keys` returns `surfaces.gemini` and `geminiModelsEndpoint` for the
dashboard card and usage example. See [Protocol Paths](protocol-paths.md#settings) for save
and rollback behavior.

Gemini clients authenticate with `x-goog-api-key` or a `?key=` query parameter. The dispatcher
clones the request, moves that credential onto `x-opencodex-api-key` (an existing dedicated header
wins), and drops it from the URL and headers, so admission sees the usual proxy key and the key is
never logged or forwarded. The idle-timeout override receives the original request. Generation takes
the Chat admission (drain, key, origin, caller session, active turn, workflow, raised body via
`isGeminiBodyPath` in `inbound-body-admission.ts`); the list and lookup routes take the
model-discovery admission `/v1/models` uses. `embedContent` and `batchEmbedContents` answer 501
`UNIMPLEMENTED` after admission; `countTokens` is described below.

The catalog starts with the same eligible route set as Ollama's `/api/tags` (`src/server/ollama-route-policy.ts`
and the key's model scope): `models/<provider>/<model>` with `generateContent` and
`streamGenerateContent`. Unknown or ineligible models are 404 `NOT_FOUND`; synthetic, shadow, combo
and caller-credential selectors are refused as for Ollama. The [opt-in Antigravity catalog](gemini-native.md)
also exposes visible cached Gemini models and their routable wire aliases. Native generation
feeds its route decision, observed reasoning and streaming timing into the same Logs details.

`src/protocols/codecs/gemini.ts` maps `contents`, `systemInstruction`, base64 image `inlineData`,
`functionDeclarations` and `toolConfig`, `functionCall` and `functionResponse` (matched by id, then by
name), and `generationConfig` (including `thinkingConfig` as reasoning effort and a JSON response
schema) onto one Chat body, reading camelCase or snake_case. Hosted Gemini tools are ignored. A field
that would change the answer (`candidateCount` other than 1, non-image inline data, file parts,
more than 1,024 function calls) is a 400. Responses map Chat finish `stop` and `tool_calls` to
`STOP`, `length` to `MAX_TOKENS` and `content_filter` to `SAFETY`; an unknown or missing finish is an
error, never a success. The Chat bridge assembles a streamed `functionCall` under the shared
translator limits for each call's arguments and for all retained tool fields in the turn. It releases
those buffers on emission, failure or cancellation. Usage becomes `usageMetadata`, with reasoning
tokens reported as `thoughtsTokenCount`.

`src/server/gemini-inbound.ts` owns translated delivery. With `alt=sse` a stream is `data: <json>\r\n\r\n`
frames; without it, one streamed JSON array. The closing chunk (finish reason and usage) is emitted
only after the Chat stream reached EOF and the inner path settled, through the shared pump in
`src/server/native-chat-bridge.ts` that Ollama also uses: identity-only internal Chat request,
Retry-After and refusal vocabulary, fixed error text by status, one request-log row committed exactly
once through [`native-final-log`](ollama-inbound.md#final-request-log), a 499 row for a client that
leaves. Errors are `{ "error": { "code", "message", "status" } }` with `status` chosen by HTTP code;
the message is fixed by code and upstream-authored text is never forwarded. Inner Chat runs with
`suppressProtocolTrace`, so no Chat protocol identity is persisted for these rows.

The shared bridge checks the source HTTP headers and parsed body for ACP unattended-turn labels.
It passes the result through Chat to Responses preflight as an internal boolean. The native
projection and request header allowlist keep those labels out of outbound requests. An ACP policy
refusal returns the native 403 before any `agy` version probe or ACP process start.

## Signatures, token counts and model limits

`src/protocols/codecs/gemini.ts` carries Gemini 3 thought signatures both ways: a `thoughtSignature` on a
`functionCall` part, or on a thought or signature-only part before it in the same turn, becomes the call's
Chat `extra_content.google.thought_signature` (see [Chat signatures](chat-reasoning-details.md#gemini-thought-signatures-on-the-chat-wire)),
and a Chat tool call's `extra_content` comes back as the part's `thoughtSignature`, buffered and streamed. A
non-string value is dropped. `:countTokens` is served with model-discovery admission and the key's model scope
(unknown or out-of-scope model 404), and because it reads and decodes a body it also holds the shared inbound-body
allowance (`runAdmittedBodyWork`, `isGeminiBodyPath`) until its answer settles, without a turn slot; a saturated
allowance answers the Google-shaped 503 (`tests/server/gemini-count-tokens-admission.test.ts`): the body (`contents`/`systemInstruction`/`tools`, or
`generateContentRequest`) is read under the inbound limit, projected with the same codec onto Chat, decoded with
`chatConversationToIr` and estimated with `estimateInputTokens`; the answer is `{ totalTokens }` and nothing goes
upstream. A body the Chat projection refuses (for example `fileData`, or no messages) is a 400. Model resources
add `inputTokenLimit` (configured provider max input, provider context-window override, matching
custom model context window, then generated model metadata) and `outputTokenLimit` (configured
provider maximum, then generated metadata) only when known, and list `countTokens` among
`supportedGenerationMethods`. `$alt=sse` is accepted as `alt=sse`; `STATUS_NAMES` follows the google.rpc
HTTP mapping, including 405 as `UNIMPLEMENTED`. Coverage: `tests/server/server-gemini-inbound-fidelity.test.ts`.

## Interactions API

`POST /v1beta/interactions` and the stable `POST /v1/interactions` (the only `/v1/` paths outside
`/v1/models/{model}:{method}` this surface claims; OpenCodex serves nothing else there) create an
interaction the same way: `src/protocols/codecs/gemini-interactions.ts` maps the create body onto one
Chat body and `src/server/gemini-interactions-inbound.ts` passes it through the shared Chat bridge
with the original request and parsed body for ACP policy. Both aliases use the generation admission,
request-log ownership and fixed-text Google errors described above. The classifier
also claims `/v1beta|v1/interactions/{id}` (GET, DELETE) and `…/{id}/cancel` (POST) so those paths get
Google-shaped answers and the same listener rules: an id is one segment of `[A-Za-z0-9_-]`, at most 128
characters, and `geminiRouteAllows` gives the by-id route two methods for the 405 `Allow` header and the
loopback allowlist.

Mapping: `input` as a string, content item(s) (text, base64 `image`) or steps (`user_input`,
`model_output`, `thought`, `function_call`, `function_result`), plus CPA-compatible `{role, content}`
turns and `{text}`/`{parts}` system instructions; `system_instruction`; `function` tools;
`generation_config` (`temperature` and `top_p` from Google's guide, `seed`, `stop_sequences`,
`max_output_tokens`, `thinking_level`, `thinking_summaries`, `tool_choice` with `any` on one function
forcing it, as the generateContent codec does); a text `response_format`. A thought step's signature
rides to the next function call as `extra_content.google.thought_signature`. A `function_result` whose
call is not in the input is reported to the handler, which refuses it until stored history exists.
The create path refuses `agent`, `background: true`, `webhook_config`, `environment`,
`agent_config`, `safety_settings`, hosted tools, input other than text and images, and non-text
output with a typed 400. The routed provider applies its own safety policy. `service_tier` is ignored. A conversation-level `system`/`developer` turn stays at
its position in the conversation; only `system_instruction` leads it.

Answers carry `object: "interaction"`, `ocx-int-` ids with 128 random bits, and `status`
`requires_action` when the turn ends in function calls, `incomplete` for `length` and
`content_filter` (Google defines it as completed with incomplete results), `completed` otherwise; usage
uses Google's `total_*` names with output excluding thoughts. Streams are `event: <type>` plus a `data`
object carrying the same `event_type`: `interaction.created` first (emitted with the first Chat chunk or
the failure frame), `step.start`/`step.delta`/`step.stop` for thought summaries (`thought_summary`),
text (`text`) and whole function calls (`arguments_delta`, with a preceding `thought_signature` step when
one exists), then `interaction.completed` after settlement, or `error` with a lower-case code.
`interaction.status_update` is not emitted: nothing runs in the background.

## Interactions state

`src/server/gemini-interactions-store.ts` keeps what `previous_interaction_id` and `GET` need, in process
memory only: nothing reaches disk or the request log, and a restart forgets every interaction (a chain
then answers 404 and the client resends history). The owner is the salted principal of the data-plane
key the caller presented, resolved with `resolveContextPrincipal` so a key presented on a loopback bind
still names its own owner, or one shared `loopback` owner for a keyless loopback caller; rotating a key
mints a new principal, so its earlier chains answer 404. A lookup, delete or cancel by any other owner is
indistinguishable from a missing id. The dispatcher sets `Cache-Control: no-store` on both
Interactions aliases, including successes and owner-scoped misses. Bounds: 24 hours from the last write (expiry is lazy, on the next
write or lookup), 1,000 entries and 64 MiB in total, 200 entries and 16 MiB per owner, and per entry the smaller of 8 MiB and the inbound body limit, since a larger history
could never be chained. A write evicts only its own owner's oldest entries, at the owner and the global limits;
when the store is full and the writer owns nothing to evict, the interaction is not kept (the answer is unaffected
and `x-opencodex-interaction-stored` says `false`), so one key's traffic never removes another's history. Only the
app-owned memory budget evicts across owners. The store is `gemini_interactions` on the app-owned memory roster (category
`continuation`, passively evictable).

A chained turn sends `system` from this request, then the stored history (prior input and answers,
including signed tool calls), then the new input; `tools`, `system_instruction` and `generation_config`
are interaction-scoped and never inherited. A `function_result` whose call is not in the input must answer
a pending call of the stored turn's last answer and lead the input, otherwise 400; a leading resend of
those pending calls is dropped so nothing is duplicated upstream. A turn is stored only after it settles:
buffered after the inner path settled, streamed inside the terminal `frames()` that the bridge calls only
on success, so failed, cancelled and unsettled turns are not kept, and a storing error never fails the
answer. The streaming translator collects full output only for a storable turn and charges retained
bytes as they arrive. Reaching the per-entry limit drops the retained output while streaming continues.
Tool fragments needed to emit a whole call are budgeted independently of storage and released after
emission. The bridge disposes the translator on success, failure, or cancellation. Buffered answers report
`x-opencodex-interaction-stored: true|false` (exposed to browsers) whenever a store was requested. `GET`
returns the stored resource with its input steps and `previous_interaction_id`; `DELETE` answers `{}`;
cancel answers 400 for an owned interaction (nothing runs in the background) and 404 otherwise.

## Coverage

`tests/server/server-gemini-inbound.test.ts` (list and lookup, SSE and JSON-array streams, buffered
answers on `/v1beta` and `/v1`, `x-goog-api-key` and `?key=` admission, tool calls, errors, 501 and
405, `/v1/models` unchanged), `tests/server/server-gemini-interactions-inbound.test.ts` and
`tests/responses/responses-gemini-interactions-codec.test.ts` (Interactions create, stream vocabulary,
refusals, by-id answers, chaining and ownership), `tests/server/gemini-interactions-store.test.ts` (owner
isolation, TTL, caps, eviction, roster), `tests/server/gemini-native-paths.test.ts` (classifier, methods, near misses),
`tests/responses/responses-gemini-codec.test.ts` (request and
response mapping, streaming translation), plus the Ollama tests that pin the shared bridge.

`tests/server/server-agy-acp.test.ts` exercises labeled and interactive turns on both generation
methods and both Interactions aliases using the fake `agy` fixture.
