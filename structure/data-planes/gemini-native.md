# Native Gemini Inbound

`src/server/index/gemini-native-routes.ts` dispatches `/v1beta/` on the authenticated
listener before the GUI fallback. The separate unauthenticated loopback, linked ingress and
management listener allowlists remain unchanged. Package-tree replacement fences native requests.

Generation uses Responses data-plane admission, origin checks, destination scopes, drain,
caller-session identity, active-turn/workflow admission and the HTTP idle-timeout override.
`src/server/gemini-native.ts` uses the enabled canonical `google-antigravity` provider and its
active, usable OAuth account. Snapshot token and project stay together, including after one
401-triggered refresh of the rejected generation. OC's provider pacing applies to each physical
send, including workflow physical-send reservation for the initial dispatch and 401 recovery.
Applicable root, identity or pool token-spend ceilings are refused before dispatch with 503 and
`gemini_native_spend_limits_unsupported`, because native token spend is unreported.
Redirects are manual; destination policy checks the configured base URL. Ingress credentials
and arbitrary request headers never go upstream. There is no transient inference replay.

`src/server/gemini-native-wire.ts` validates JSON objects but embeds the original request source
under the CCA `request` member. It extracts the response member by source offsets, preserving
unknown fields, integer precision, number spelling, tool arguments and thought signatures.
Neither direction passes through internal Messages/Responses conversion, model aliases,
effort rewriting, schema repair, signature replay caches or built-in tool emulation.

The methods are `POST /v1beta/models/gemini-*:generateContent` and
`POST /v1beta/models/gemini-*:streamGenerateContent`. Streaming always uses SSE. Only the
CCA response envelope is removed; SSE framing is regenerated and keepalive comments discarded.
UTF-8 and CR/LF delimiters can span chunks. Missing/duplicate wrappers, malformed or oversized
frames, incomplete final frames and EOF before all observed candidates finish terminate delivery,
with no resend after output. A blocked prompt or native error is also terminal; `[DONE]` alone is not.

Request and buffered response bodies and each SSE event have a 16 MiB ceiling; a lower configured
`maxInboundBodyBytes` also narrows request admission. Compressed requests are rejected with 415.
Header waits use `connectTimeoutMs`; upstream body inactivity uses `stallTimeoutSec`, with
non-positive values disabling that upstream timer. Client upload inactivity has a separate timer
that resets per chunk and clears before OAuth/pacing; a disabled upstream timer leaves the default
300-second upload protection in place. Upload inactivity returns 408.
Request abort, shutdown, stream cancellation, failure and EOF release their turn and transport
owners. Native parsing does not borrow the translator budget or retain replay state.

`src/server/gemini-native-catalog.ts` serves `GET /v1beta/models` and individual model metadata
from OC's known AGY registry/cache/config catalog, filtered by destination scope. Pagination uses
`pageSize` (1–1000, default 50) and an offset `pageToken`. Listing is not an upstream entitlement
check. Unsupported methods and Interactions return explicit errors.

`src/server/gemini-native-log.ts` records delivery status, latency, client and admission identity
without inspecting payloads or retaining prompts/signatures. Token usage and pricing are unreported. Native SSE error objects are forwarded unchanged but
settle the delivery log as failed without copying the upstream error message.
Upstream HTTP errors use a fixed native JSON error and retain only a numeric Retry-After.

Coverage: `tests/server/gemini-native-wire.test.ts`, `tests/server/gemini-native.test.ts` and
`tests/server/gemini-native-routes.test.ts`.
