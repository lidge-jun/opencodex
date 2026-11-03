# Proxy-Owned Error Detail

Request-log rows carry only error facts this proxy owns. `projectErrorDetail` in
`src/usage/error-detail.ts` runs on the final row in `addFinalRequestLog` before any writer (an
injected one included) and again first in `addRequestLog`, so the live ring, `/api/logs` and the
`usage.jsonl` projection read one projected entry; `normalizeUsageEntry` applies `errorDetailFor` to every
append and read, and `requestLogEntryFromPersistedUsage` runs `projectErrorDetail` on hydration (on a copy
of the attempts), so it bounds tiers and drops upstream fields itself even for a row that did not come
through the disk reader. A row keeps:

- `errorCode` from the literal `LOG_ERROR_CODES` vocabulary or a proxy-formatted `http_NNN`; any other
  value (an upstream code that reached a writer) collapses to the status fallback (`invalid_request_error`,
  `invalid_api_key`, `permission_denied`, `rate_limit_exceeded`, `client_closed_request`,
  `server_is_overloaded`, `upstream_server_error`, `http_NNN`, else `upstream_error`). Attempt codes are
  normalized the same way, and upstream text fields removed from attempts, in place.
- `upstreamCondition`, a member of the closed set in `src/lib/upstream-condition.ts`, derived only for a
  failed row with upstream evidence; a client close (499, `client_closed_request`, `client_cancelled`) gets
  none, and a stored condition is kept only under the same rules. Text set through
  `recordLocalFailureDetail` is not upstream evidence unless the caller passes `upstreamEvidence: true`
  (the Messages passthrough restating an upstream status and closed type); `upstreamErrorIsLocal` keeps
  it out of the final row's evidence. The Messages passthrough classifies the condition where it parses the
  upstream error and stores only the member on the context (`upstreamCondition`), so a native Anthropic
  overflow is recorded as `context_overflow`. `classifyUpstreamCondition` reads status, bounded structured
  tokens and, for 4xx only, fixed lowercase keyword sets: 401 is authoritative, structured tokens come next
  (account usage-limit codes `usage_limit_exceeded` and `1308` are billing exhaustion), context overflow
  from text needs the definite verdict `isDefiniteContextOverflow` in the dependency-free
  `src/lib/context-overflow-verdict.ts` (the one combo failover uses, re-exported by
  `src/combos/failover.ts`), so a validation error that quotes "prompt is too long" stays rejected, a 429 that
  names a rate limit stays `rate_limited` even when it also mentions quota, a 5xx stays a server failure
  whatever its text says, and a bare status maps to a fixed condition. It is presentation-only; routing,
  retry and recovery keep their own classifiers in `src/lib/errors.ts`. `upstreamConditionMessage` holds the
  proxy-written sentence for each member and names only a well-formed configured provider id.
- `rateLimitResetAt`, finite epoch milliseconds after the request and at most eight days later, derived
  server-side from the exact Meta Muse quota sentence on a Muse 429; the dashboard quota observation in
  `gui/src/muse-limit-observation.ts` reads only this number. Legacy rows that stored the sentence recover
  the number on hydration.
- `failureDetail`, a closed `{ code, value?, type? }` from `src/lib/failure-detail.ts`: `code` is a member of
  `FAILURE_DETAIL_CODES`, `value` a safe integer (milliseconds or bytes) kept only for codes that take one,
  and `type` a closed Anthropic error class kept only on `provider_error`. `recordLocalFailureDetail` in
  `src/server/request-log-failure-detail.ts` takes the detail beside the English text it leaves on the
  context; `incompleteReasonDetail` maps the known `incomplete_details.reason` values (`max_output_tokens`,
  `upstream_stall_timeout`, `adapter_eof`), and an unknown reason stays on the context only. A relayed error
  that exactly matches one of the proxy's own timeout or client-close sentences (`PROXY_SENTENCES`) becomes
  its code with the parsed number, bounded to seven digits. `boundedFailureDetail` validates every append,
  read and hydration; free text (a row from an earlier build or an edited one) is dropped. The dashboard
  renders the code through `failureDetailLabel` in `gui/src/pages/logs-failure-summary.ts` and the
  `logs.failureDetail.*` catalog keys in every locale.

`upstreamError`, `upstreamErrorCode`, `upstreamErrorType` and `upstreamRequestId` stay on the request
context, where status heuristics and classifiers read them, and never reach a row, `usage.jsonl` or the
service log. Bytes already in `usage.jsonl` from earlier builds are not rewritten; they are dropped on every
read and hydration. The Logs detail shows the localized condition and the failure detail.
`tests/usage/request-log-error-detail.test.ts` covers the vocabulary, projection, hydration and the Muse
round trip; `tests/server/upstream-error-detail-boundaries.test.ts` drives native Chat, Responses
passthrough and both Messages lanes against an upstream that echoes its credential, and checks the live
row, `usage.jsonl`, hydration and console output.

## Service tier and model identity

A recorded response service tier is a member of `RESPONSE_SERVICE_TIERS` in
`src/lib/response-service-tier.ts` (`auto`, `default`, `flex`, `scale`, `priority`, `fast`, `standard`,
`ultrafast`, case-folded); any other value is omitted. `boundedServiceTier` applies at capture (the
Responses payload in `src/server/request-log.ts`, both FastWire observers in `src/providers/fastwire.ts`), in
the live projection for the row and every nested `tierOutcome`, and in `normalizeUsageEntry`. Fast
confirmation still reads the raw observation, so a configured wire value outside the set confirms Fast
without being recorded.

An upstream-reported model is kept only when it equals a model id this proxy already knows, because no
identifier grammar can tell a prefixless credential from a model name. `knownModelIdentity` in
`src/lib/model-identity.ts` applies `boundedModelIdentity` (`[A-Za-z0-9._:/@-]`, at most 128 characters,
unchanged by the secret redactor) and then requires an exact match with one of: the ids the route names
(`routeKnownModels` in `src/usage/log.ts`: the routed model and its unprefixed form, the wire model, the
requested model and alias, and every attempt's target), the bundled Codex catalog
(`src/codex/catalog/pinned-models.ts`), or the bundled metadata catalog for the selected provider
(`src/generated/model-metadata.ts`). It returns the proxy's copy of the matched id. `servedModel` and
`resolvedModel` pass it independently at capture (`recordObservedServedModel` and the passthrough
`openai-model` header in `src/server/responses/passthrough-delivery.ts`), and again in `addRequestLog`,
`normalizeUsageEntry` and hydration through `modelIdentityLogFields`; anything else is not recorded. Relayed
WebSocket model headers use the same rule with the requested model as the known id.
`sanitizePassthroughHeaders` in `src/server/relay.ts` applies the rule to the relayed `openai-model` and
`x-codex-safety-buffering-faster-model` headers itself, so no passthrough branch (redirects, error
statuses, JSON answered as JSON or re-framed as SSE) can relay an unknown value. The passthrough passes it
the route's ids plus the models the user configured for the selected provider (`models`,
`retainModels`, `defaultModel`), so a provider-owned hint naming one of them survives as the proxy's
copy. Live-discovered ids are never trusted anywhere the rule applies: the upstream's own `/models`
answer chose them, so a hint naming a model known only from discovery is not relayed. `selectedModels`
is not trusted either, because a model preset fills it from that same discovered catalog; a hint naming
a model that is only preset-selected is not relayed. Rows do not see that provider list,
so a served model that only it names is relayed in the header but not recorded.
`tests/usage/request-log-identity-bounds.test.ts`, `tests/usage/request-log-served-model.test.ts` and
`tests/server/response-model-identity.test.ts` cover capture, live, ledger, hydration, the `/api/logs` DTO
and the passthrough header.

## Response metadata headers

`src/server/safe-response-headers.ts` lists each upstream response header a client may receive as
response metadata (WebSocket metadata frames, the WS-to-HTTP projection, the HTTP-to-WS error bridge) by
exact name in a `Map`, so a header named after an `Object.prototype` member (`constructor`, `__proto__`,
`toString`) never resolves, and `normalizeSafeResponseHeader` returns only primitive strings, validating or
rebuilding each value against its contract, so no upstream bytes are copied:
retry advice through `formatClientRetryAfter`; models through `boundedModelIdentity`; rate-limit counts
as non-negative integers (fractions round down, clamped to 10^12); rate-limit resets as integer seconds
(rounded up, clamped to eight days) or Go-style durations rebuilt from whole seconds (whole milliseconds
below one second); booleans, credit balances and quota percentages, windows and reset times as numbers
this proxy formats. Codex quota windows are relayed for the ordinary family and the metered
`bengalfox` family only (`CODEX_QUOTA_FAMILIES`): a header name is upstream text too, so any other family
is dropped. Request ids, the models etag (the client reads this proxy's own catalog, which carries no
validator), quota limit labels and free-text headers such as the promo message are not relayed.

The turn-state token is the one value a client must send back: Codex replays `x-codex-turn-state` on
later requests of the turn, and on the WebSocket upgrade, to keep the turn on one backend.
`src/server/turn-state-handles.ts` issues a random handle (`ocx-ts-` and 32 hex digits) per token and
binds it to the send that received the token: a digest of the admitted caller (configured key id,
environment principal or loopback), the provider name and the outbound account (the ChatGPT account id,
or the outbound credential when there is none). The mapping lives in process memory (bounded to 4096
entries, six-hour expiry). Each request and each WebSocket `response.create` frame runs in its own caller
scope (`runTurnStateCallerScope`, opened by the server's `fetch` wrapper and the frame handler), which
`admissionFields` in `src/server/auth-cors.ts` fills. A handle is redeemed only at the physical send in
`src/server/responses/fetch-helpers.ts`, after admission and routing: the outbound header and
`client_metadata["x-codex-turn-state"]` map back to the token when the send's binding matches, and are
removed otherwise, with the fixed service-log flag `turn_state_binding_mismatch` for a mismatch. The WS
upstream receives the same binding on its init, and the exchange issues handles with it; without a
binding a token is dropped. Handles, tokens and bindings are never logged; a value that is not a handle
passes unchanged.

`codex-ws-metadata.ts` checks the raw byte budget first, then keeps only normalized values. It rebuilds
the native `codex.rate_limits` frame field by field: known limit ids (`codex`, `codex_bengalfox`), a
closed set of plan labels, the `allowed`/`limit_reached` flags, quota windows with the percent clamped to
100 at two decimals and integer window and reset values, and the credit flags. Every other field is
discarded, including the credit balance, which clients receive only as the proxy-formatted
`x-codex-credits-balance` header; the windows of an unknown limit id are dropped rather than relabelled.
The connection-level `x-reasoning-included` seed stays present, since Codex reads it by presence, but
carries only an exact `true`/`false` or an empty value.
`tests/server/safe-response-headers.test.ts` covers the allowlist, each contract and both WebSocket
consumers; `tests/server/turn-state-handles.test.ts` covers the handle map and drives a real server over
HTTP and WebSocket.

## Client retry advice

Client `Retry-After` advice is a string this proxy formats: `formatClientRetryAfter` in
`src/lib/client-retry-after.ts` turns delay seconds (fractions round up) or an HTTP date in any RFC 9110
form (IMF-fixdate, RFC 850, asctime, all read as GMT field by field) into
an integer of seconds clamped to 0..691200 (eight days, so a weekly usage-window reset such as a local Codex account
cooldown still reaches the client), and yields nothing for any other input. The Ollama surface keeps its
own smaller bound (`ollamaRetryAfter`). Every other client boundary uses `formatClientRetryAfter`
(translated errors, native Chat and Messages including pacing refusals, Messages passthrough, the Responses
error re-wrap, compact, context history, WebSocket response metadata, fallback refusal, Copilot refusal,
usage-limit and combo-unavailable refusals, Codex account cooldowns and the Claude subscription cooldown). Internal cooldown and
retry scheduling keep reading the parsed evidence through `resolveClientRetryAfter` and
`src/combos/failover.ts`. `tests/server/client-retry-after-sites.test.ts` and
`tests/lib/client-retry-after.test.ts` cover the sites and the format.
