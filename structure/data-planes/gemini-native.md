# Native Gemini Inbound

The [Gemini-compatible dispatcher](gemini-inbound.md) owns every path, listener decision and
admission check. In `src/server/index/gemini-routes.ts`, the native leg is available only for
`/v1beta` generation with `protocols.rollout.geminiNativeAntigravity: true` and a concrete Gemini
route to the enabled, canonical `google-antigravity` OAuth provider in Cloud Code Assist mode.
Requests outside those conditions use the Chat bridge. Advisor and sidecar capability requests
use the bridge for their inherited-policy checks. The Google Antigravity Accounts tab edits the
existing rollout flag through the protocol settings PATCH.

The native leg checks the captured admission model scope against the resolved destination.
On admission it copies the router's decision into the shared request log.
`src/server/gemini-native-catalog.ts` extends the configured Gemini catalog with visible Gemini
models from the existing Antigravity discovery cache and the shared model visibility filter.
List, lookup and token counting apply the same route and key checks to the advertised
destination. A key can allow a concrete tier without allowing its source family. Wire aliases are published only when routing the alias selects
the native leg and maps to that same wire ID. These reads reuse the cached roster and start no
upstream discovery. Generation resolves the Antigravity wire model before accessing OAuth.

`src/server/gemini-native.ts` uses the shared Antigravity account preferences and per-account
discovery roster for the resolved wire model. Proactive selection follows OAuth account failover
settings. An account with a known omission cannot receive the request. The selected account's
token and project come from one snapshot, including after one 401-triggered refresh. Each
physical send uses provider pacing, reserves one workflow send and rechecks the account's model
support, pause, reauthentication and removal. The first send advances a configured round-robin
cursor. Applicable root,
identity, or pool token-spend ceilings refuse the request with 503 and
`gemini_native_spend_limits_unsupported`. The native leg does not settle token spend. The
destination policy checks the base URL and redirects remain manual. Only proxy-constructed
headers and the bound OAuth credential go upstream.

`src/server/gemini-native-wire.ts` validates the JSON object and embeds the original request
under the CCA `request` member. It extracts successful `response` members by source offsets
so unknown fields, integer precision, number spelling, tool arguments and thought signatures
survive. CCA SSE is reframed as Gemini SSE with `alt=sse` and as a streamed JSON array otherwise.
Malformed or oversized events, missing or duplicate envelopes, incomplete final events and
EOF before all observed candidates finish terminate delivery without a replay. A blocked prompt
also counts as completion when no candidates were observed. A valid `[DONE]` or a sanitized
in-band error ends delivery and cancels the upstream body. Before sending buffered JSON or a
complete stream frame, the native leg checks the original JSON and its decoded strings for
bound OAuth tokens, project IDs and private account identifiers from both sends. A match returns
the same fixed Gemini error as an in-band upstream error. HTTP failures retain only bounded
numeric retry advice.

Request and buffered response bodies and each SSE event have a 16 MiB ceiling. A lower
`maxInboundBodyBytes` narrows the request limit. Compressed requests are refused with 415.
Headers use `connectTimeoutMs` and upstream body inactivity uses `stallTimeoutSec`, with
non-positive values disabling that upstream timer. Upload inactivity has an independent timer
that resets per chunk and clears before OAuth and pacing. Disabling upstream stalls leaves the
default 300-second upload timeout in effect. A stalled upload returns 408. Cancellation,
shutdown, failure and EOF release the turn and transport. Native parsing owns no replay state.

`src/server/gemini-native-log.ts` records final status, latency, client and admission identity.
Native errors fail the request-log row. A physical send marks the [protocol trace](protocol-paths.md)
as native Gemini, which the dashboard uses for its protocol badge, and records the wire model and
an opaque account label in the shared attempts. The log preserves the first 401 before refresh.
Only a physical replay records a second attempt with the OAuth recovery reason. Successful buffered responses
and complete streams supply normalized token counts through the shared Google usage parser.
For a stream, only its last valid cumulative snapshot is recorded. The dashboard derives its
end-to-end token rate from output tokens and request duration. When an API price matches,
the cost estimate accounts for reported cache hits at the read rate. Gemini generation usage
has no cache-write counter. For a credential replay with both priced and unpriced attempts,
`src/server/management/shared.ts` returns a display-only subtotal and the unpriced attempt count.
Request cost summaries still count such a request as unpriced. The attempts table displays each
valid opaque account label. Reasoning diagnostics use an explicit Gemini thinking control or the
selected wire model's effort suffix. Text and tool-call deltas supply the streaming output
window and first visible output time. Reported thought tokens require a thought delta before
estimating decode throughput. Payloads and provider diagnostics are omitted from the log.

Coverage lives in `tests/server/gemini-native-routes.test.ts`,
`tests/server/gemini-native-wire.test.ts` and `tests/server/gemini-native.test.ts`.
