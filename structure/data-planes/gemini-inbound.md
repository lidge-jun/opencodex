# Gemini-Compatible Inbound

Gemini clients (the google-genai SDK with a custom base URL, `agy` with its `genai` gateway wire
protocol, `GOOGLE_GEMINI_BASE_URL`) can use configured provider routes through the Gemini REST
shape. Like the [Ollama inbound](ollama-inbound.md) it is a translation onto the
[Chat Completions inbound](inbound-compat.md) path and never talks to Google itself.

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

Gemini clients authenticate with `x-goog-api-key` or a `?key=` query parameter. The dispatcher
clones the request, moves that credential onto `x-opencodex-api-key` (an existing dedicated header
wins), and drops it from the URL and headers, so admission sees the usual proxy key and the key is
never logged or forwarded. The idle-timeout override receives the original request. Generation takes
the Chat admission (drain, key, origin, caller session, active turn, workflow, raised body via
`isGeminiGenerationPath` in `inbound-body-admission.ts`); the list and lookup routes take the
model-discovery admission `/v1/models` uses. `countTokens`, `embedContent` and
`batchEmbedContents` answer 501 `UNIMPLEMENTED` after admission.

The catalog is the same eligible route set as Ollama's `/api/tags` (`src/server/ollama-route-policy.ts`
and the key's model scope): `models/<provider>/<model>` with `generateContent` and
`streamGenerateContent`. Unknown or ineligible models are 404 `NOT_FOUND`; synthetic, shadow, combo
and caller-credential selectors are refused as for Ollama.

`src/protocols/codecs/gemini.ts` maps `contents`, `systemInstruction`, base64 image `inlineData`,
`functionDeclarations` and `toolConfig`, `functionCall` and `functionResponse` (matched by id, then by
name), and `generationConfig` (including `thinkingConfig` as reasoning effort and a JSON response
schema) onto one Chat body, reading camelCase or snake_case. Hosted Gemini tools are ignored. A field
that would change the answer (`candidateCount` other than 1, non-image inline data, file parts,
more than 1,024 function calls) is a 400. Responses map Chat finish `stop` and `tool_calls` to
`STOP`, `length` to `MAX_TOKENS` and `content_filter` to `SAFETY`; an unknown or missing finish is an
error, never a success. A streamed tool call is accumulated and emitted as one whole `functionCall`
part. Usage becomes `usageMetadata`, with reasoning tokens reported as `thoughtsTokenCount`.

`src/server/gemini-inbound.ts` owns delivery. With `alt=sse` a stream is `data: <json>\r\n\r\n`
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

## Interactions API

`POST /v1beta/interactions` and the stable `POST /v1/interactions` (the only `/v1/` paths outside
`/v1/models/{model}:{method}` this surface claims; OpenCodex serves nothing else there) create an
interaction the same way: `src/protocols/codecs/gemini-interactions.ts` maps the create body onto one
Chat body and `src/server/gemini-interactions-inbound.ts` runs it through the Chat path with the
generation admission, request-log ownership and fixed-text Google errors described above. The classifier
also claims `/v1beta|v1/interactions/{id}` (GET, DELETE) and `…/{id}/cancel` (POST) so those paths get
Google-shaped answers and the same listener rules: an id is one segment of `[A-Za-z0-9_-]`, at most 128
characters, and `geminiRouteAllows` gives the by-id route two methods for the 405 `Allow` header and the
loopback allowlist. This proxy stores no interaction yet, so get and delete answer 404 and cancel 501.

Mapping: `input` as a string, content item(s) (text, base64 `image`) or steps (`user_input`,
`model_output`, `thought`, `function_call`, `function_result`), plus CPA-compatible `{role, content}`
turns and `{text}`/`{parts}` system instructions; `system_instruction`; `function` tools;
`generation_config` (`temperature` and `top_p` from Google's guide, `seed`, `stop_sequences`,
`max_output_tokens`, `thinking_level`, `thinking_summaries`, `tool_choice` with `any` on one function
forcing it, as the generateContent codec does); a text `response_format`. A thought step's signature
rides to the next function call as `extra_content.google.thought_signature`. A `function_result` whose
call is not in the input is reported to the handler, which refuses it until stored history exists.
Refused with 400 rather than silently changed: `agent`, `background: true`, `previous_interaction_id`
(no stored interactions yet), `webhook_config`, `environment`, `agent_config`, hosted tools, non-text
content or output. `service_tier` and `safety_settings` are ignored, as unknown fields are.

Answers carry `object: "interaction"`, `ocx-int-` ids with 128 random bits, and `status`
`requires_action` when the turn ends in function calls, `incomplete` for `length` and
`content_filter` (Google defines it as completed with incomplete results), `completed` otherwise; usage
uses Google's `total_*` names with output excluding thoughts. Streams are `event: <type>` plus a `data`
object carrying the same `event_type`: `interaction.created` first (emitted with the first Chat chunk or
the failure frame), `step.start`/`step.delta`/`step.stop` for thought summaries (`thought_summary`),
text (`text`) and whole function calls (`arguments_delta`, with a preceding `thought_signature` step when
one exists), then `interaction.completed` after settlement, or `error` with a lower-case code.
`interaction.status_update` is not emitted: nothing runs in the background.

## Coverage

`tests/server/server-gemini-inbound.test.ts` (list and lookup, SSE and JSON-array streams, buffered
answers on `/v1beta` and `/v1`, `x-goog-api-key` and `?key=` admission, tool calls, errors, 501 and
405, `/v1/models` unchanged), `tests/server/server-gemini-interactions-inbound.test.ts` and
`tests/responses/responses-gemini-interactions-codec.test.ts` (Interactions create, stream vocabulary,
refusals, by-id answers), `tests/server/gemini-native-paths.test.ts` (classifier, methods, near misses),
`tests/responses/responses-gemini-codec.test.ts` (request and
response mapping, streaming translation), plus the Ollama tests that pin the shared bridge.

`tests/server/server-agy-acp.test.ts` exercises labeled and interactive turns on both generation
methods using the fake `agy` fixture.
