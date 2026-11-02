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
  none. `classifyUpstreamCondition` reads status, bounded structured tokens and,
  for 4xx only, fixed lowercase keyword sets: 401 is authoritative, structured tokens come next, a 429 that
  names a rate limit stays `rate_limited` even when it also mentions quota, a 5xx stays a server failure
  whatever its text says, and a bare status maps to a fixed condition. It is presentation-only; routing,
  retry and recovery keep their own classifiers in `src/lib/errors.ts`. `upstreamConditionMessage` holds the
  proxy-written sentence for each member and names only a well-formed configured provider id.
- `rateLimitResetAt`, finite epoch milliseconds after the request and at most eight days later, derived
  server-side from the exact Meta Muse quota sentence on a Muse 429; the dashboard quota observation in
  `gui/src/muse-limit-observation.ts` reads only this number. Legacy rows that stored the sentence recover
  the number on hydration.
- `failureDetail`, proxy-authored transport text (fixed sentences, numeric guard limits, closed provider
  type names) set through `recordLocalFailureDetail` in `src/server/request-log-failure-detail.ts`, or the
  fixed label for a known `incomplete_details.reason` (`max_output_tokens`, `upstream_stall_timeout`,
  `adapter_eof`); single line and at most 500 characters. An unknown reason stays on the context only.

`upstreamError`, `upstreamErrorCode`, `upstreamErrorType` and `upstreamRequestId` stay on the request
context, where status heuristics and classifiers read them, and never reach a row, `usage.jsonl` or the
service log. Bytes already in `usage.jsonl` from earlier builds are not rewritten; they are dropped on every
read and hydration. The Logs detail shows the localized condition and the failure detail.
`tests/usage/request-log-error-detail.test.ts` covers the vocabulary, projection, hydration and the Muse
round trip; `tests/server/upstream-error-detail-boundaries.test.ts` drives native Chat, Responses
passthrough and both Messages lanes against an upstream that echoes its credential, and checks the live
row, `usage.jsonl`, hydration and console output.

## Client retry advice

Client `Retry-After` advice is a string this proxy formats: `formatClientRetryAfter` in
`src/lib/client-retry-after.ts` turns delay seconds (fractions round up) or an IMF HTTP date into an integer
of seconds clamped to 0..3600, and yields nothing for any other input. Every client boundary uses it
(translated errors, native Chat and Messages, Messages passthrough, the Responses error re-wrap, compact,
context history, WebSocket response metadata, fallback refusal and Copilot refusal). Internal cooldown and
retry scheduling keep reading the parsed evidence through `resolveClientRetryAfter` and
`src/combos/failover.ts`. `tests/server/client-retry-after-sites.test.ts` and
`tests/lib/client-retry-after.test.ts` cover the sites and the format.
