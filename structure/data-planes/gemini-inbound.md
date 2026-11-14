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
`managementIngressRouteAllowed` in `src/server/index.ts` denies them and all of `/v1beta/`, the
unauthenticated listener allowlists do not list them, and the package-tree fence answers them in
the Gemini error shape. OPTIONS takes data-plane origin policy.

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

## Coverage

`tests/server/server-gemini-inbound.test.ts` (list and lookup, SSE and JSON-array streams, buffered
answers on `/v1beta` and `/v1`, `x-goog-api-key` and `?key=` admission, tool calls, errors, 501 and
405, `/v1/models` unchanged), `tests/responses/responses-gemini-codec.test.ts` (request and
response mapping, streaming translation), plus the Ollama tests that pin the shared bridge.
