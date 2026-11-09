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
  the number on hydration. Direct log rows also classify non-enumerable or inherited quota
  evidence before discarding its text; `tests/usage/request-log-normalization.test.ts` covers both.
- `failureDetail`, a closed `{ code, value?, type?, validation? }` from `src/lib/failure-detail.ts`: `code` is a member of
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

For schema-validation 4xx responses, native Chat and the translated adapter dispatch capture
`failureDetail.validation` before client formatting. `src/lib/upstream-validation-detail.ts` projects
only closed field identities and validation types from structured `detail[].loc/type`, inspecting at
most 64 issues and retaining at most eight distinct pairs. Known nested locations retain closed paths such as `messages.role` or `messages.content`; other nested
locations become a closed root plus `.*`. Arbitrary keys, indexes, messages, inputs, contexts and unknown
types are dropped. The optional error type must be an allowlisted upstream type; absent/unknown types
are omitted. Existing 64 KiB upstream error-body retention limits remain authoritative: over-limit or
partial bodies produce status-only diagnostics.
`boundedFailureDetail` revalidates those pairs on live projection, usage append/read, hydration and
GUI rendering. The dashboard appends the machine field/type pairs to its localized provider-error
label. No upstream-authored free text is retained, and client-facing messages retain their existing policy.

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

## Client error bodies (Chat)

`src/lib/client-error-body.ts` owns Chat error-response normalization. Native upstream failures,
translated upstream-derived failures, converters and direct encoders emit
fresh envelopes with a fixed proxy message, a closed type and code, and `param: null`.
The local `chatCompletionsErrorBody` API retains its message semantics for identified local callers.
Messages body normalization follows the separate contract below; Responses formatting retains its existing contract.

`ownedChatErrorPayload` selects literal messages through `classifyUpstreamCondition` and closed
exact-message/token tables; it never copies the evidence text. Unknown types use the status type (authentication, permission, rate limit, server, or
invalid request). Unknown codes use `invalid_api_key` for 401, `model_not_found` for 404,
`rate_limit_exceeded` for 429, and null otherwise. Map lookups return proxy literal values and
are prototype-safe. Model identifiers are never extracted from error text. A provider annotation
accepts only the configured provider id with the shared 1–64 character id grammar.

Explicit client contracts take precedence over diagnostic-sentence matching. In particular, an
upstream incomplete event cannot select structural diagnostic wording by copying a sentence; only
producer provenance selects the legacy message path. Fixed contracts cover context overflow, cyber policy, terminal refusals, replay refusal, translation
buffer limits, inconsistent refusal representations, undeclared tools, unsatisfied required tools,
transport failure and incomplete streams. Context overflow uses the fixed context-window sentence;
cyber policy uses `CYBER_POLICY_FALLBACK_MESSAGE`. No contract interpolates upstream fields.
`src/lib/error-destination.ts` bounds any destination named by a local send-budget error. The
constructor accepts an opaque branded label and revalidates it while building the message. URL
labels contain only a parsed supported scheme, hostname and optional port; userinfo, path, query
and fragment are omitted, and invalid inputs become `the provider`. Fixed provider labels accept
only the shared 1–64 character provider-id grammar. A copied object cannot mint a label. Kiro,
adapter-owned physical sends, native Chat, compact, sidecar and translated dispatch pass complete
URLs to this projection instead of trusting a caller's description. Retry helpers carry this
client label separately from their operational log label. Queue-overload and OAuth provider-error constructors validate
the configured provider id themselves; unsupported-provider remediation applies that same bound
and retains the existing credential-pattern redaction on its derived label. These bounds also apply before request-log persistence.

Proxy-authored local errors retain their legacy Chat message, type and code. The preflight
transport and send-budget phase results in `src/server/responses/core-pipeline.ts`
carry a process-local object identity. Sidecar-auth prepares state and does not return a Response; `src/server/responses/core-lifetime.ts` and the deferred
log wrapper carry that identity through their owned response wrappers. Passthrough error
rewrapping and the non-replayable projection carry existing ownership without granting it
to an upstream response. The request-preparation
phase can also return a combo's upstream error and therefore does not confer local ownership.
Its local fixed-message, Reserve, replay-state and input-admission constructors mark their own
responses; generic route exception messages remain unowned because they can contain catalog text.
OAuth constructors in adapter and passthrough dispatch mark responses built from the public OAuth
remediation formatter. Typed Codex auth, pacing, key-scope, workflow-budget, spend-storage and local Anthropic pool-refusal constructors
mark their locally selected responses too; their arguments come from local policy classes and counters.
Request decoding, cancellation, encrypted-task/replay compatibility and unavailable-combo constructors
retain ownership too. Combo refusals omit combo aliases and model strings. They report the target count, target indices,
provider labels validated by `providerErrorDestinationLabel`, and closed exclusion reasons.
`clientFacingModelLabel` captures a same-request client selector before compaction, memory, shadow,
redirect or cached-model resolution. Its opaque identity and strict 128-character identifier bound
are required by scope, Antigravity and input-admission message builders; synthetic children carry
the original label in process-local options. Compact captures that label from the raw client body before compaction routing or session recall, carries it into recursive compact handoffs and Responses dispatch, and recovery carries the same identity. Messages captures it before directives, picker aliases and context markers are decoded. Locally generated combo overflow envelopes use the original label in every response model field, including created and terminal events; synthetic child response projections retain that label across normalization. Error-only overflow and policy builders, including sidecar projection, take the original label rather than the wire model. Rewritten combos retain the original selector in their logical request rows and decision traces, including after stream commitment; configured JEV identity stays internal. Failed rewritten turns project wire, resolved, served, echoed and attempt model identities to client or catalog values. Chat routing-policy refusals also use that original label; an operator alias never supplies a
profile id to the message or request row. Command Code plan refusals use fixed wording because
the adapter request contains the resolved wire model. Local model refusals project their request
rows to client or catalog model identities and validated provider ids, omitting an untrusted routing decision. `projectAdmissionModelDeniedLog` in `src/server/admission-model-scope.ts` applies that bound before any Chat, Claude or native Messages final-log write, and before returning late guard, compact and sidecar refusals. The response builder only builds the owned envelope. The projected original selector (or fixed placeholder) is recorded explicitly even when compact routing has not initialized the context. Input-admission projection runs before either buffered or streaming delivery. Input-only ceilings are named as input limits; the actual shared context window remains separate in both direct refusals and combo-exhaustion wording. No provider diagnostic
is interpolated into those local messages. No serialized flag, code or header mints identity.
The shared builders live in `src/combos/resolve.ts`, `src/server/admission-model-scope.ts`,
`src/server/responses/input-admission.ts` and `src/oauth/generic-account-failover.ts`.
`src/lib/upstream-retry.ts` owns the retry constructors. For a transient 5xx, `fetchWithTransientRetry`
does not resend a response whose bounded body prefix proves context overflow. It reads at most 16,384
bytes from a clone within 250ms or until cancellation, leaving the returned body intact. Event streams
and bodies without an observed verdict retain the normal retry; a verdict observed before a slow or
endless body stalls still stops retry. Hypothetical, negated, question-form and configuration-failure
mentions are excluded per sentence in the unwrapped provider message, so they cannot hide a definite
overflow in another sentence. A throttle worded only as "too many tokens" is not a verdict, while an
explicit "prompt is too long" remains a verdict when no throughput signal is present.
Body inspection time does not count toward the upstream slow-attempt budget, and empty chunks cannot
starve the deadline or cancellation. The retry and cancellation
contracts are exercised in `tests/lib/upstream-retry.test.ts`.
`InvalidSendBudgetError` displays only a finite non-negative number or `invalid`.
`UpstreamRetryEvidenceError` uses fixed retry-evidence wording and retains the original rejection
only as `Error.cause`. Chat request-read failures keep typed local size/encoding messages; other
stream, decompression and parse exceptions use `Invalid JSON body`.
The undeclared-tool guard records its fixed sentence in a WeakMap keyed by the request's
log context. `UNDECLARED_TOOL_CALL_MESSAGE` contains no tool name: the shared guard, native Messages,
Responses bridge and passthrough refusals all emit `routed provider emitted undeclared client tool; only request-declared tools may be called`.
No upstream tool name enters that refusal or its request-log diagnostic. The converter accepts that exact message only in the same request with its registered type/code
(or the proxy classifier's corresponding field values); a copied message cannot authorize arbitrary
error fields. The explicit
collector sink carries its local ownership into buffered delivery. Recovery and continuation
projection record the transformed legacy message only while holding a locally marked Response
or a recognized local budget/admission error. The direct Chat encoder receives this same request
context; copied adapter-event fields cannot supply ownership. Combo commitment shares the
child context record, including guard decisions made after commitment; combo failure rebuilding
carries local Response identity or verifies an exact message in that child record. An upstream error naming an
undeclared tool does not enter that record. Buffered JSON guard refusals mark the constructed Response.

Local send-budget, spend-storage, key-scope, usage-limit and workflow-ceiling context reasons also
retain the legacy envelope. Reachable writers for these reasons make local admission or budget
decisions; upstream attempt codes are separate. Account auto-pause identity selects fixed guidance
for an upstream refusal after a persisted pause decision; it does not make that response's text local.
Native local validation and admission sites retain their own messages by call-site provenance.
Synthetic incomplete events carry producer provenance: the direct adapter driver marks its watchdog
and EOF terminal objects by identity. The Zed adapter marks only its generated EOF event. The
Responses bridge and native terminal repair register their generated reasons in a request-scoped
WeakMap, shared with the returned stream and the request context through owned wrappers and combo
commitment. Sidecar loops carry that same context. The Chat converter accepts synthetic reasons only
from that registry and only without a supplied message, matching the generated event shape; upstream
copies of the sentence and reason receive owned incomplete wording even after an earlier local event.
Neither text, a serialized flag nor a reason code establishes this origin. Genuine synthetic event
bytes, collector verdicts, terminal decisions and log evidence retain their existing semantics.
A closed exact-message map covers malformed/empty completion diagnostics, missing-terminal wording and the
explicit-empty-tool-catalog refusal. Its values are complete proxy literals: arbitrary suffixes,
reason strings and tool-name slots never match. The actionable plan-refusal map recognizes only
`MODEL_NOT_IN_PLAN` and emits its own complete remediation message, preserving the proxy's token
without copying surrounding text. Every failure with unknown provenance receives owned wording.

`src/server/chat-native-sse.ts` builds nested terminal errors as canonical owned error envelopes.
Flat `type: "error"` payloads and `event: error` frames that the ordinary relay accepts retain that relay's
control flow. They do not settle the stream, populate a failure verdict, capture an upstream failure,
cancel the reader or authorize combo fallback. Usage, progress and terminal inspection read the original
chunk before normalization. For parsed flat payloads, client bytes are a fresh block with a flat
`{message,type,param,code}` object, `param: null`, and no other upstream fields. Buffered collection keeps
the ordinary completion outcome; a following `[DONE]` retains its success meaning. For buffered native
requests, `ChatCompletionsCollectorSource` in `src/chat/outbound.ts` retains a client projection through
the matching emitted flat frame. Usage contains only finite, non-negative numeric `prompt_tokens`,
`completion_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens` and `audio_tokens`, and
`completion_tokens_details.reasoning_tokens`, `audio_tokens`, `accepted_prediction_tokens` and
`rejected_prediction_tokens`; each object is rebuilt and all other properties are omitted.
Service tier uses `boundedServiceTier` from `src/lib/response-service-tier.ts`; unknown values are omitted.
Choices retain only the first choice fields the collector consumes: closed finish reason, completion
text/refusal/reasoning content, declared reasoning entry fields and tool-call content. Reasoning entries
preserve `reasoning.summary.summary`, `reasoning.text.text` (and any validated signature), and
`reasoning.encrypted.data`. Shared entry metadata accepts non-negative safe integer indices, bounded
versioned format descriptors, and reasoning IDs of at most 128 characters in the `reasoning-`,
`reasoning_`, `summary-`, `summary_`, `rs-` or `rs_` namespaces; valid primitive values remain unchanged.
Unknown finish reasons become `error`; unknown reasoning types and extra diagnostic metadata are omitted.
Thinking signatures use the existing signature validator. Raw chunks still feed usage and log observers
before projection. The native capture also reads `delta.reasoning` and original tool identities;
that observer sees the original chunk, while the buffered collector keeps its existing
`reasoning_content` behavior. Fields the collector ignores (including legacy `function_call`, roles,
choice indices and annotations) are not newly exposed by this projection. This bounded ordinary-chunk source is separate from the failure-verdict sink; collection
consumes its entries and releases all retained bytes on exit.
An original SSE event name exactly equal to `error` selects the fixed proxy line `event: error` before
the owned flat data payload, preserving the SDK's error signal. Other upstream event names are dropped.
The effective event name is determined before the absent-data, empty-data and `[DONE]` branches too.
For those named error blocks, framing contains only the fixed event line and the branch's data: absent
data adds no data line, empty data remains empty, and `[DONE]` remains `[DONE]`. Upstream id, retry,
comment and other control lines are omitted. Settlement, reader cancellation, collection, combo and
log decisions keep the ordinary branch behavior. Ordinary blocks retain their existing control lines.
Collectors continue to use data-based decisions; the fixed event line does not introduce an internal
terminal error. Existing nested terminal
frames retain their original settlement, log evidence and collector verdict behavior.
Generated errors select their client type/code from the computed legacy envelope, including message-derived
cyber policy. Empty/mid-tool EOF and read failures retain `upstream_sse_truncated` and `upstream_sse_error`.
A choice error equal to null or undefined is absent: ordinary framing, buffered JSON, collection
and terminal decisions remain unchanged. Other choice-scoped errors get fresh data-only framing: only `choices[i].error` changes, to
`{message,type,code}`. All other fields match the ordinary relay, including unfinished sibling
choices, usage, roles, refusal, reasoning and tool fields. Buffered native JSON replaces only those
choice errors and preserves its envelope and message representation. Choice errors do not become
terminal failures; the existing status, finish and `[DONE]` behavior remains authoritative.

Internal side channels retain the evidence used before normalization:

- `src/chat/failure-verdict.ts` defines an explicit response-scoped sink shared by each producer
  and collector, including `foldChatCompletion` and the delivery lifetime wrapper. The verdict is
  calculated with the legacy Chat payload's collector rules and retains the original message.
  It is consumed only when a top-level error frame is parsed, never on EOF or a choice error;
  an error frame that could not be emitted cannot turn EOF into a failure. Incomplete terminals
  retain their original message for classification before the client text changes.
- Native failure responses carry the legacy body in a Response-keyed WeakMap. Combo consumption
  runs the same bounded reader on a new Response of that text: 65,536 bytes, signal, display safety,
  truncation and server-error UTF-8 validity rules all match ordinary consumption. It cancels the
  unused normalized body. Headers and identity markers remain on the original response, so quota
  provenance, retry/cooldown, replay, non-replayability and verified plan refusal retain their inputs.
- Translated HTTP errors pass their legacy envelope as the deferred inspection source in
  `src/server/relay.ts` and `src/server/response-log-body.ts`. The complete existing JSON inspection
  runs at EOF only, with its existing first-message guard and independent diagnostic capture.
  Cancellation, read failure and inspection overflow do not inspect JSON. The size bound applies
  to the legacy source, and preinspected responses still suppress inspection. The owned body is
  never inspected in its place. Original evidence remains available to request-log projection.

HTTP status, retry advice formatting, replay headers, terminal callbacks and internal adapter
terminal objects retain their prior decisions. Tests cover these boundaries in
`tests/lib/client-error-body.test.ts`, `tests/responses/chat-error-body-normalization.test.ts`,
`tests/responses/chat-error-collector-verdicts.test.ts` and
`tests/server/server-chat-error-body-evidence.test.ts`.

### Closed Chat tables

| Table | Proxy literal members |
| --- | --- |
| OpenAI types | `invalid_request_error`, `authentication_error`, `permission_error`, `not_found_error`, `rate_limit_error`, `server_error`, `upstream_error`, `insufficient_quota`, `client_cancelled`, `cyber_policy`, `model_not_allowed_for_key`, `api_error`, `overloaded_error` |
| OpenAI codes | `spend_ledger_storage_unavailable`, `previous_response_not_found`, `client_cancelled`, `client_closed_request`, `cyber_policy`, `input_admission_refused`, `inbound_body_too_large`, `context_length_exceeded`, `tool_catalog_too_large`, `rate_limit_exceeded`, `insufficient_quota`, `request_send_budget_exhausted`, `origin_rejected`, `upstream_server_error`, `invalid_api_key`, `permission_denied`, `location_not_supported`, `subscription_required`, `server_is_overloaded`, `invalid_request_error`, `usage_limit_reached`, `slow_down`, `misalignment_policy_violation`, `invalid_prompt`, `bio_policy`, `model_not_in_plan`, `upstream_reset_replay_refused`, `upstream_no_response`, `upstream_closed_before_response`, `claude_subscription_cooldown`, `model_not_found`, `model_not_allowed_for_key`, `undeclared_tool_call`, `required_tool_contract_unsatisfied`, `translation_buffer_limit`, `invalid_refusal`, `unsupported_feature`, `agent_assertion_unsupported`, `upstream_error`, `upstream_sse_truncated`, `upstream_sse_error`, `upstream_sse_unterminated`, `upstream_sse_invalid`, `upstream_stream_incomplete`, `upstream_stream_error`, `upstream_stall_timeout`, `upstream_incomplete`, `server_busy`, `outbound_body_too_large`, `codex_no_account`, `memory_model_target_unavailable`, `intercept_target_unavailable`, `observation_barrier_timeout`, `claude_thread_unsupported`, `claude_compatibility_configuration`, `claude_compatibility_unsupported`, `unsupported_credential_domain`, `unsupported_synthetic_selector`, `unsupported_shadow_rewrite`, `workflow_sends_exhausted`, `workflow_children_exhausted`, `workflow_concurrency_exhausted`, `workflow_spend_exhausted`, `workflow_tracking_exhausted`, `workflow_send_replayed`, `workflow_pool_history_unresolved`, `workflow_spend_undurable` |
| Anthropic types | `invalid_request_error`, `authentication_error`, `permission_error`, `not_found_error`, `request_too_large`, `rate_limit_error`, `api_error`, `overloaded_error`, `billing_error`, `timeout_error`, `conflict_error`, `send_budget_exhausted` |
| Anthropic codes | `invalid_request_error`, `authentication_error`, `permission_error`, `not_found_error`, `request_too_large`, `rate_limit_error`, `api_error`, `overloaded_error`, `billing_error`, `timeout_error`, `conflict_error`, `send_budget_exhausted`, `spend_ledger_storage_unavailable`, `previous_response_not_found`, `client_cancelled`, `client_closed_request`, `cyber_policy`, `input_admission_refused`, `inbound_body_too_large`, `context_length_exceeded`, `tool_catalog_too_large`, `rate_limit_exceeded`, `insufficient_quota`, `request_send_budget_exhausted`, `origin_rejected`, `upstream_server_error`, `invalid_api_key`, `permission_denied`, `location_not_supported`, `subscription_required`, `server_is_overloaded`, `usage_limit_reached`, `slow_down`, `misalignment_policy_violation`, `invalid_prompt`, `bio_policy`, `model_not_in_plan`, `upstream_reset_replay_refused`, `upstream_no_response`, `upstream_closed_before_response`, `claude_subscription_cooldown`, `model_not_found`, `model_not_allowed_for_key`, `undeclared_tool_call`, `required_tool_contract_unsatisfied`, `translation_buffer_limit`, `invalid_refusal`, `unsupported_feature`, `agent_assertion_unsupported`, `upstream_error`, `upstream_sse_truncated`, `upstream_sse_error`, `upstream_sse_unterminated`, `upstream_sse_invalid`, `upstream_stream_incomplete`, `upstream_stream_error`, `upstream_stall_timeout`, `upstream_incomplete`, `server_busy`, `outbound_body_too_large`, `codex_no_account`, `memory_model_target_unavailable`, `intercept_target_unavailable`, `observation_barrier_timeout`, `claude_thread_unsupported`, `claude_compatibility_configuration`, `claude_compatibility_unsupported`, `unsupported_credential_domain`, `unsupported_synthetic_selector`, `unsupported_shadow_rewrite`, `workflow_sends_exhausted`, `workflow_children_exhausted`, `workflow_concurrency_exhausted`, `workflow_spend_exhausted`, `workflow_tracking_exhausted`, `workflow_send_replayed`, `workflow_pool_history_unresolved`, `workflow_spend_undurable`, `desktop_model_mapping_unavailable`, `thread_unsupported_request` |

The Anthropic code set is the union of Anthropic types, OpenAI codes,
`desktop_model_mapping_unavailable` and `thread_unsupported_request`. The locally constructed
thread refusal retains `thread_unsupported_request` only in `error.details.error_code`; the
normalized general envelope does not copy that reserved extension into `error.code`.

## Messages error bodies and headers

`src/lib/messages-error-body.ts` builds fresh Anthropic error envelopes from the shared literal tables
in `src/lib/client-error-body.ts`. Buffered native errors, caller-forward Messages/count_tokens errors,
translated replies, the Responses converter and the direct encoder use fixed condition or contract text.
The writers are `src/server/claude-messages.ts`, `src/server/messages-native.ts`,
`src/claude/outbound.ts` and `src/protocols/encoders/messages.ts`.
Special-code and catch returns build the baseline envelope before choosing a fixed sentence.
Buffer-limit records keep 413 and their code while retaining baseline recovery recognition.
Fixed proxy budget, guard, usage and unfinished-turn sentences retain their wording; upstream
messages and native transport/model-route diagnostics select recovery from their original display.
The response helper keeps that baseline envelope in the shared combo-evidence side channel.
Only object identity or producer registration retains local wording. Ingress constructors mark fixed
sentences individually; rejected roles and tool-block prefixes use fixed placeholders. Original client
model selectors use the brand in `src/lib/error-destination.ts`; configured destination strings do not
supply client error text. Local pre-handler, admission and thread-refusal envelope shapes stay intact.

Status, retry, overflow, rotation, quota and logging decisions retain their original evidence.
`messagesOverflowPresentation` in `src/lib/messages-error-body.ts` selects only the owned compaction
sentence by applying Claude Code's case-insensitive, unanchored phrase check to the message this
path previously delivered: "prompt is too long" or "input is too long for requested model".
Native HTTP retains its existing overflow verdict and formatter; native fold retains its sized-error
branch, formatter and redaction. Translated replies, converter and direct encoder use their legacy
formatter's message. Buffered passthrough Messages/count_tokens and raw direct collection use the
SDK diagnostic from the original relayed body: a truthy top-level message wins, otherwise parsed JSON is serialized;
non-JSON errors use their raw text. Buffered passthrough Messages/count_tokens rebuild only
non-2xx bodies. Every 2xx passthrough body retains its original bytes, including any error member
or envelope marker; status stays unchanged, and only the approved response headers normalize.
Native fold and raw direct collection project every collected error event, including HTTP-200
records, by the collector's recorded event identity rather than the payload shape. Empty, malformed
and non-object payloads keep their original collector/status result as internal evidence; their
client envelope is rebuilt too. A record's original client-visible message or serialized payload
selects recovery wording even when its status is 200. Incomplete translated JSON uses its original
formatter message
before selecting the fixed incomplete or compaction sentence. Internal overflow decisions and HTTP
status stay separate
from this client-message check: a coded raw-collector throughput refusal still answers 400 without
selecting the compaction sentence. The shared `isContextOverflowError` adds `upstream_server_error`
to the generic codes and ignores conditional context-window matches while still checking later matches;
its remaining source and the #8128 suite stay byte-identical, enforced by
`tests/claude-integration/messages-overflow-baseline-contract.test.ts`. The executable overflow golden compares actual client recovery-phrase recognition,
HTTP status and the original internal decisions independently on every fixture/path row.
The direct Messages writer also applies that shared verdict to the emitted code: a definite generic-coded overflow carries `context_length_exceeded`, the fixed compaction sentence and HTTP 400 on collection, even with `retryable: true`; original error evidence and proxy/transport metadata remain separate. `tests/helpers/messages-overflow-assertions.ts` records the affected fixture ids only on direct-stream/direct-fold as explicit expected changes to the immutable golden. All other paths keep their baseline comparisons; the fixture data is not regenerated.
The translated non-2xx plain-text path classifies up to 16,384 characters before selecting the bounded
400-character display text, so an overflow visible to the retry peek is not lost to display truncation.
Adapter response-body inactivity emits the guard's bounded duration sentence and `upstream_stall_timeout` code for streamed initial, recovery and continuation errors. Terminal status classification records 504 for that code, while the duration sentence supplies the closed `body_stall` failure detail. A request-local continuation marker survives event spreads and empty-completion retry handling, and selects HTTP 504 for a buffered continuation stall; other buffered failures and provider-supplied codes retain their prior HTTP status. Initial buffered adapter timeouts also return 504 and the same detail sentence. `tests/server/terminal-guard-server.test.ts` covers stream, buffered continuation and marker isolation; `tests/server/error-fidelity.test.ts` distinguishes a stall from a 502.
The direct encoder retains original adapter fields by terminal identity independently of shared
classification. Buffered passthrough and count_tokens preserve the upstream status and closed
type/code. The type chosen
by that writer survives collection independently of the final HTTP status: a converted rate-limit
error can retain `rate_limit_error` inside a 502. `src/claude/failure-verdict.ts` carries delivered legacy
records into the collector without serializing them; publication follows successful frame admission. The sink records error-event dispatch independently
of JSON parsing, so scalar, array, malformed and empty payloads cannot suppress projection.
The direct sink in `src/protocols/encoders/adapter-events.ts` acknowledges successful enqueue through an
optional callback. Failure admission charges the legacy frame size, keeping buffer-limit decisions
independent of replacement-message length. The enqueued owned terminal frame can exceed the charged bytes by its size difference from the legacy frame, for at most one frame per stream. Request logging and combo evidence retain original records separately.

Special-code and catch returns inspect their baseline-rendered message before choosing a fixed
sentence. This includes collected buffer errors, transport reads, policy failures and request
translation. Catch diagnostics retain the baseline Error.message/String(thrown) conversion
only as internal evidence; converted text never becomes owned client wording. A failed
conversion propagates as it does on the original path. Fixed local budget and guard refusals retain their original wording. The inbound
Messages and direct IR codecs use `messagesRolePresentation` in `src/lib/messages-error-body.ts`
to preserve recovery recognition and failed JSON-role coercion status without displaying the role.
The legacy envelope stays in the combo-evidence side channel, separate from the owned response.

Messages local-refusal presentation uses construction-registered process metadata in
`src/lib/client-error-body.ts`, carried through response clones and registered terminal contexts.
`src/lib/messages-error-body.ts` selects fixed guidance from that closed reason or a closed local
code; serialized fields and diagnostic text cannot register a reason. The original message still
feeds status, recovery, logs and private combo evidence. Messages/count_tokens non-2xx delivery
removes selector fields from scope refusals and never renders request/configuration labels, limits
or upstream reset times. Shared producers retain their existing bytes for Chat and other surfaces.
HTTP workflow refusals enter the same Messages projection at
`src/server/admitted-http-turn.ts`. A replacement refusal keeps its own construction identity.

Only buffered/folded Messages consumers receive a legacy-record sink; streaming delivery does
not retain those records. Adapter iterator-read failures alone carry transport provenance;
writer and terminal-hook faults retain the generic proxy-failure presentation. The Responses SSE
converter likewise distinguishes reader.read failures from frame-processing and output faults.
Kiro continuation HTTP normalization carries local ownership and presentation metadata before
registering the terminal error. Successful buffered
passthrough retains guarded usage accounting, then returns its original body before error
inspection or serialization.

`src/server/messages-native-tool-guard.ts`, `src/server/messages-shared.ts` and
`src/server/sse-payload-rewrite.ts` carry complete-frame construction identity.
Native combo replay evidence is collected before framing transforms; if a transform fails before preflight, complete output or opaque frames and an unfinished raw frame prevent replay. A complete empty message prelude and ping remain replayable. The accounting tap remains the owner of stream outcomes and error presentation; after an error it conservatively marks a long unfinished frame as followed, bounding repeated tail inspection.
Native and passthrough Messages SSE apply error-response normalization after echo, guard,
accounting tap and the existing configured-only overflow rewrite. The final enqueue stage in
`src/server/messages-sse-error-filter.ts` introduces no stream queue, timer or possible-prefix hold.
Only a block whose first non-comment field is exactly `event:error` or `event: error` is eligible.
Every other block retains its original bytes, chunk boundaries and logical enqueue turns, including
later error declarations, data/id/retry-first blocks and ordinary events above 1 MiB. Leading
comments do not consume first-field eligibility and retain their bytes. Final contained errors emit
only the closed error declaration, data fields and terminator; all other post-declaration fields
are omitted, including with empty data. Within-bound non-error renames retain their original fields.

One eligible block holds at most 1 MiB of original suffix bytes, including interleaved fields.
Within the bound, a final non-error rename replays those bytes unchanged with the permitted suffix
delay. A final error uses one full JSON parse and the shared private diagnostic selector in
`src/lib/messages-error-body.ts`: truthy top-level message, otherwise whole-value serialization,
with the pinned SDK's parsed-or-raw SSE fallback. Empty named errors retain generic SDK dispatch.
`src/lib/messages-sse-error-presentation.ts` renders closed type/code/message literals and carries
complete-frame construction identity. The single pre-echo flag authorizes owned data under the
existing message_start name; guard replacements retire that flag. Local guard and tap products
keep their original observer bytes and separate fixed client products. Stall/cap text omits numbers;
reader errors omit exception suffixes. Guard callbacks, tap accounting/settlement, budgets,
collectors, combo evidence and request-log decisions consume the original evidence.

The two accepted exceptions are FOLD-502 (native collected explicit errors that formerly returned
proxy-built 200 envelopes now return/log 502, preserving their presentation) and OVERSIZE-1M
(eligible suffixes above 1 MiB force api_error, no code, and the fixed sentence
"The provider stream reported an error.", with no compaction phrase and unchanged issued status).
An above-bound rename also forces that error; it cannot recover discarded data. The hold releases
at the boundary, cancellation, read error or failed enqueue, without another admission limit.
Native workflow refusals carry spend detail into the existing fixed workflow/unbound presentation.

`tests/fixtures/messages-sse-895a85989.json` records actual base status, raw-byte hashes/lengths,
compressed bytes, enqueue/read traces, pinned SDK 4f27519/Claude Code 2.1.288 recognition and original
observer facts. Its generation-only helper overlays exact 895a85989 git-show modules; normal tests
require no git. `tests/claude-integration/messages-native-stream-parity.test.ts` retains every
success/internal row and explicitly lists the ten changed error-response normalization rows.
`tests/server/messages-sse-error-filter.test.ts`,
`tests/server/messages-sse-error-lifecycle.test.ts` and the Messages SSE integration siblings cover
first-field eligibility, formatting, bounds, identity handoffs, teardown and both exceptions.
`tests/claude-integration/messages-sse-control-fields.test.ts` covers final-error fields and rename replay.
`tests/claude-integration/messages-sse-continuation.test.ts` checks later-event and EOF delivery after
a suppressed split-CRLF continuation; pull completion depends on actual client output.
The converter and direct encoder own their separate terminal writers.
`tests/claude-integration/messages-error-normalization.test.ts` and
`tests/claude-integration/messages-lane-errors.test.ts` exercise buffered and converted boundaries.

`src/server/anthropic-rate-limit-headers.ts` preserves all validated RFC 3339 reset fraction
digits in UTC, up to nine digits with trailing zeros trimmed. Integer calendar/offset arithmetic
converts the whole seconds; fractions never pass through Date or floating-point arithmetic. Zero
fractions are omitted. Numeric epoch resets retain their separate decimal rounding contract.
It renders an exact-name union: requests, tokens, input-tokens
and output-tokens each have limit/remaining/reset, plus unified status/reset and 5h/7d/7d_oi window
status/reset/utilization. Counts are integers in 0..10^12. Documented resets validate Gregorian RFC 3339
calendar components and offsets, then render canonical UTC with the validated fractional precision. Unified resets accept strict decimal
seconds through 253402300799, at most six input fractional digits and three output digits. Decimal
utilization stays on its original scale (0.62 remains 0.62), bounded to 0..100 with four output digits.
Rounding cannot exceed the maximum. Only the closed status values `allowed` and `rejected` survive;
other values, including `allowed_warning`, and unknown names are dropped. Raw quota consumers read the
unchanged upstream headers. `tests/claude-integration/messages-header-normalization.test.ts` checks all
retained names, bounds, date conversion and the forwarded statusLine fixture contract.

`src/server/messages-response-headers.ts` omits upstream request IDs. The Messages ledger wrapper in
`src/server/index/startup-warnings.ts` retains proxy-generated request-id/x-opencodex-request-id and
removes the upstream diagnostic header and its existing CORS exposure token. count_tokens gains no
ledger ID. Retry-After continues to use the shared formatter, including zero and existing fallbacks.
Successful buffered passthrough bodies retain their bytes. Their media type is regenerated from
application/json, text/plain or text/event-stream, with only utf-8/us-ascii charset parameters; other
media types use application/octet-stream. Rebuilt error bodies always use literal application/json.
`tests/claude-integration/messages-success-media-types.test.ts` checks both buffered entry points;
`tests/claude-integration/messages-overflow-verdicts.test.ts` compares every owned path with
`tests/fixtures/messages-overflow-decisions.json`. Its explicit baseline generator observes the
existing branch verdicts without changing their results or client bytes. Normal tests run head only
and require no git history; client recovery-phrase recognition, HTTP status and internal decisions
must each match the baseline.

The overflow comparison is divided among six sibling test files using
`tests/helpers/messages-overflow-assertions.ts`. Each test executes at most 64 rows in one child;
no hook computes the complete matrix. The same fixture, case-table hash and per-row assertions
cover every lane. Direct Response byte checks remain in
`tests/claude-integration/messages-overflow-verdicts.test.ts`. Local refusal and delivery checks
live in `tests/claude-integration/messages-proxy-refusals.test.ts` and
`tests/claude-integration/messages-review-regressions.test.ts`.
