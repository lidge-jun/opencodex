# Ollama-Compatible Inbound

Ollama clients can use configured provider routes through five native endpoints. The surface is a
translation onto the [Chat Completions inbound](inbound-compat.md) path; it never runs local models.

`src/server/ollama-native-paths.ts` names five exact routes: `GET /api/version`, `GET /api/tags`,
`POST /api/show`, `POST /api/chat` and `POST /api/generate`. `src/server/index/ollama-routes.ts`
matches them in `serve-options.ts` before the management `/api/` catch-all, so every other `/api/*`
path still reaches management authentication. A wrong method gets a native 405 with `Allow`, never
the management or GUI fallback. OPTIONS on the five paths takes data-plane origin policy and CORS.
The routes are served only by the authenticated data-plane listener: the unauthenticated loopback
and hub-link allowlists do not list them, and `managementIngressRouteAllowed` in `src/server/index.ts`
denies them before its `/api/*` admission. The package-tree fence covers them like `/v1/*`.

Admission is reused, not reimplemented. Version, tags and show take the model-discovery admission
`/v1/models` uses. Chat and generate take the Chat Completions admission: drain, data-plane key,
origin, caller session promotion, the idle-timeout override, active-turn, workflow and raised body
admission (`OLLAMA_JSON_BODY_ROUTES` in `inbound-body-admission.ts`). `src/server/admitted-http-turn.ts`
owns the admitted turn for every HTTP route; its optional `mapRefusal` reshapes drain, active-turn,
workflow and body refusals into `{ "error": string }` with their status and `Retry-After`, and its
`onAdmissionError` turns a cancelled body-admission wait into one logged 499. Unlogged drain and
active-turn refusals carry no `x-opencodex-request-id`; logged refusals and handler-owned requests do.

The catalog is configured concrete provider/model routes, not local models.
`src/server/ollama-route-policy.ts` refuses synthetic fast/effort selectors and configured shadow
sources (400), and policy selectors, combos and transports that consume the caller's own
authorization (403), before any dispatch; tags and show list only what passes the same check and the
key's model scope. Show returns no file, digest, template or license facts.

`src/protocols/codecs/ollama.ts` validates the native body (unknown fields and options, `think`,
`keep_alive`, non-JSON formats and remote images are 400s) and projects it to Chat; base64 images
become Chat `image_url` data URLs with the sniffed media type. Chat requests accept at most 1,024
tool calls in aggregate, and tool-call IDs and pending results are indexed so validation work stays
linear in the request size. `src/server/ollama-inbound.ts` calls
`handleChatCompletions` with a synthesized request carrying only the content type, caller session
and workflow identity headers (`session_id`, `session-id`, `thread-id`, `x-session-id`,
`x-codex-parent-thread-id`, so the workflow root's spend ceiling still applies) and the client
signal, linked to the same session lane; authorization, cookies and admission keys never cross the
hop. Native error bodies are a fixed message chosen by HTTP status (`ollamaInnerErrorMessage`);
upstream-authored error text is never forwarded. Response headers are generated, never copied:
`content-type`, `Retry-After` reformatted by `ollamaRetryAfter` as an integer of seconds (at most
3600) or dropped, `Allow` on 405, an `x-opencodex-local-refusal` constant looked up from the known
workflow refusal codes (anything else is dropped), plus CORS and `x-opencodex-request-id` from the
dispatcher. The package-tree fence answers these paths in the same native shape. Buffered and NDJSON output map Chat
finish `stop`, `tool_calls` and `length` to `done_reason`; content filtering, unknown finishes and a
missing finish are native errors without `done: true`. A stream emits its single `done: true` record
only after the Chat stream reached EOF and the inner path settled, so trailing usage is included and
a later error never follows a success terminal.
Success is the Chat layer's settled outcome, not a second judgment: the native Chat relay ends at
`[DONE]` for every Chat client. For an NDJSON request answered by a non-streaming JSON Chat
completion, the shared fallback stream (`jsonCompletionSse`) supplies `stop` for a missing finish, as
it does for ordinary Chat clients; an actual SSE stream that settles without a finish stays a native
error. A buffered request passes the raw JSON through, so a missing finish there is a native error.

## Final request log

`src/server/native-final-log.ts` owns the row for these requests. `interceptFinalRequestLog` in
`request-log.ts` turns the inner Chat path's final-log requests into a settlement signal; the native
handler commits once through `commitInterceptedFinalRequestLog` with the outer status, so a
conversion failure after an inner 200 is a 502 row while the physical attempt keeps its 200. The
coordinated write skips the client-close 5xx-to-499 rewrite and derives the attempt's own failure
attribution from attempt facts. If the inner path has not settled 100 ms after the outer outcome is
known, the row drops partial usage (so the send settles as unresolved), records
`observation_barrier_timeout`, and never reports success. Inner Chat runs with
`suppressProtocolTrace`, so a native row persists no Chat protocol identity (see
[Protocol Paths](protocol-paths.md#observed-trace)).
Upstream evidence stays on the context through the final write, so the condition and quota reset are
derived from it; the [row projection](error-detail.md) then drops the upstream-authored text
(`upstreamError`, `upstreamErrorCode`, `upstreamErrorType`, `upstreamRequestId`) before any writer.

## Protocol trace

A native ingress that translates into Chat (the Ollama-compatible routes in
`src/server/ollama-inbound.ts`) passes `suppressProtocolTrace`. `suppressProtocolTrace(logCtx)` puts
the context in a process-local WeakSet; every request-context mark writer (entry, blocked, reason,
shadow) and `protocolTraceForRequest` check it, and native Chat does not set `inboundProtocol`, so no
Chat identity is persisted for that row. Envelope creation and the representability check still
run. `tests/server/protocol-trace-suppression.test.ts` pins this.

## Coverage

Coverage: `tests/server/server-ollama-inbound.test.ts` (routes, admission, CORS, buffered and NDJSON
chat/generate, finish mapping, tools, images, refusals and row agreement),
`tests/server/server-ollama-inbound-lifecycle.test.ts` (dispatcher ownership, drain, timeout override,
zero-send selector refusals, cancellation, failover attempts on live and persisted rows, workflow
root token ceiling), `tests/server/server-ollama-inbound-errors.test.ts` (fixed error bodies; an
upstream echoing a prefixless provider key never reaches the body, headers or either log),
`tests/responses/responses-ollama-codec.test.ts`, `tests/server/server-ollama-route-policy.test.ts`,
`tests/server/server-native-final-log.test.ts`, `tests/server/admitted-http-turn.test.ts` and
`tests/server/protocol-trace-suppression.test.ts`. Listener denial is pinned in
`tests/server/loopback-listener-integration.test.ts` and `tests/clients/link-routes.test.ts`, and
fencing in `tests/ci-workflows/package-tree-integrity.test.ts`.
