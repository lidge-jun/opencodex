# Proxy-Owned Error Detail

Request-log rows carry only error facts this proxy owns. `projectErrorDetail` in
`src/usage/error-detail.ts` runs on the final row in `addFinalRequestLog` before any writer (an
injected one included) and again first in `addRequestLog`, so the live ring, `/api/logs` and the
`usage.jsonl` projection read one projected entry; `normalizeUsageEntry` applies `errorDetailFor` to every
append and read, and `requestLogEntryFromPersistedUsage` uses it on hydration. A row keeps:

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
  it out of the final row's evidence. `classifyUpstreamCondition` reads status, bounded structured tokens and,
  for 4xx only, fixed lowercase keyword sets: 401 is authoritative, structured tokens come next, a 429 that
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

`servedModel` and `resolvedModel` each pass `boundedModelIdentity` in `src/lib/model-identity.ts` on their
own: `[A-Za-z0-9._:/@-]`, at most 128 characters, and unchanged by the secret redactor. `addRequestLog`,
`normalizeUsageEntry` and hydration apply it through `modelIdentityLogFields`; relayed model headers use the
same check. `tests/usage/request-log-identity-bounds.test.ts` covers capture, live, ledger, hydration and the
`/api/logs` DTO.

## Response metadata headers

`src/server/safe-response-headers.ts` lists each upstream response header a client may receive as
response metadata (WebSocket metadata frames, the WS-to-HTTP projection, the HTTP-to-WS error bridge) by
exact name, and `normalizeSafeResponseHeader` validates or rebuilds each value against its contract:
retry advice through `formatClientRetryAfter`; request ids `[A-Za-z0-9_-]` up to 128; models through
`boundedModelIdentity`; booleans, rate-limit counts, credit balances and quota percentages, windows and
reset times as numbers this proxy formats; rate-limit resets as Go-style durations it rebuilds; turn state
and etags by token grammar. Codex quota windows may name a limit family
(`x-codex-<family>-primary-used-percent`), whose name segment follows the native frame's bounded grammar.
Free-text headers such as the promo message are not relayed. `codex-ws-metadata.ts` checks the raw byte
budget first, then keeps only normalized values. `tests/server/safe-response-headers.test.ts` covers the
allowlist and each contract.

## Client retry advice

Client `Retry-After` advice is a string this proxy formats: `formatClientRetryAfter` in
`src/lib/client-retry-after.ts` turns delay seconds (fractions round up) or an IMF HTTP date into an integer
of seconds clamped to 0..691200 (eight days, so a weekly usage-window reset such as a local Codex account
cooldown still reaches the client), and yields nothing for any other input. The Ollama surface keeps its
own smaller bound (`ollamaRetryAfter`). Every other client boundary uses `formatClientRetryAfter`
(translated errors, native Chat and Messages including pacing refusals, Messages passthrough, the Responses
error re-wrap, compact, context history, WebSocket response metadata, fallback refusal, Copilot refusal,
usage-limit and combo-unavailable refusals, Codex account cooldowns and the Claude subscription cooldown). Internal cooldown and
retry scheduling keep reading the parsed evidence through `resolveClientRetryAfter` and
`src/combos/failover.ts`. `tests/server/client-retry-after-sites.test.ts` and
`tests/lib/client-retry-after.test.ts` cover the sites and the format.
