# Replay Refusals

## Client projection

`src/lib/upstream-retry.ts` defines two proxy-owned terminal codes. The historical
`upstream_reset_replay_refused` also covers a dispatched POST whose response-header deadline
caused fetch to fail. `src/client/link-relay.ts` uses `upstream_response_refused` when a limit
or caller abort rejects a resolved Home response. Both describe an exchange the upstream
may already have processed. The [error-detail contract](error-detail.md#client-error-bodies-chat)
defines the surrounding client envelope.

`src/server/responses/fetch-helpers.ts`, the Google and Kiro attempt wrappers, image-model
physical sends and native Anthropic Messages passthrough give caller cancellation precedence.
Kiro and Google classify POST header deadlines using the attempt’s physical-send receipt. The shared classifier accepts the owned deadline reason either as the executor rejection or as the direct cause of its Error. Caller cancellation takes precedence and propagates the caller reason. Before the receipt, Kiro returns HTTP 504 and Google retains its ordinary timeout handling.

Image dispatch distinguishes a deadline before a physical send from one after that POST left;
only the latter becomes a replay refusal. A Messages inference refusal uses HTTP 429 and the
Anthropic envelope. The `count_tokens` deadline returns 504. Safe GET/HEAD and unrelated
TimeoutErrors retain their existing status.

Native and translated HTTP delivery preserve the fixed 429 envelope, exact code and
`x-should-retry: false` across JSON rewraps, including combo and Messages conversion.
The envelope omits `Retry-After`. The translated Messages SSE writer and collector preserve
the fixed payload when a Responses SSE terminal pairs a recognized refusal code with
`response.retryable: false`. The collector also applies the HTTP retry veto.
The direct Messages writer also retains recognized refusal codes, independently of a conflicting
adapter status, `retryable` flag or overflow-like diagnostic. Only successful frame admission
publishes this verdict to its collector. A matching collected terminal returns the same fixed
429 envelope and retry veto; an unmatched raw record cannot borrow that verdict. Streaming
delivery preserves the fixed error code and wording without changing committed HTTP headers.
`src/server/responses/non-replayable-error.ts` projects the same verdict for direct and
Combo native Responses. A failed terminal or an error-bearing completed or incomplete
terminal with a recognized refusal code or explicit veto carries fixed error text and
`response.retryable: false`. Projection replaces both error carriers and keeps only
recognized codes in `incomplete_details.reason`. Buffered delivery applies
`x-should-retry: false`, removes `Retry-After`, and uses HTTP 429 for recognized codes
or the existing status for an uncoded veto. Combo preserves the projected body when
it consumes a failed member, and accounting reads the upstream evidence.
The upstream-owned `upstream_no_response` and `upstream_closed_before_response` retain
their status and retry policy. After a link relay has committed response headers, a later stream
failure cannot replace the original HTTP status; the body can end abruptly instead. See
[Remote Link](../remote-link.md) for the pre-header and post-header distinction.

An explicit proxy-owned refusal keeps its terminal status and fixed message even when the
diagnostic resembles context overflow. A header-only directive blocks resends and leaves
definite overflow normalization and response ownership intact. Combo HTTP errors with the
directive use fixed text. The original local scope envelope requires the process-local
scope presentation marker. Native Chat projects the observed code alongside a nested
diagnostic and in an HTTP 200 buffered error.

## Resend and quota evidence

The synthesizing transport owns the in-process replay-refusal marker. Formatters carry it
across rewraps. Only the fixed-envelope constructor attests to the client body bytes, so
other rewraps still need client projection. An upstream wire code selects the fixed client
message and allowlisted headers. A wire directive blocks automatic resends when headers
arrive. Both signals preserve genuine upstream quota evidence.

The shared envelope walker gates retries, credential recovery, same-request fallbacks and
terminal delivery. It checks the root and response records, their error and last_error records,
and their incomplete_details records. It follows cause records and details records or array entries
from those carriers, up to 12 edges from the root. HTTP and translated adapters also
check the legacy error.last_error carrier through the same walker.
Echoed request data has no authority over retry decisions. Kiro
and Google HTTP check the directive and a bounded peek for refusal codes before adapter
resends. Google keeps original evidence when raw errors are requested; display normalization
retains the veto and projects recognized codes to the fixed refusal. Native Chat, Responses,
Compact, Messages, continuation and sidecar paths also honor the veto.
The transient ladder checks 429s even at budget exhaustion. Native Chat, managed native
Messages and translated Responses also check 429s on their reset-only paths. Translated
Responses checks replacement errors before a same-key retry or key or account rotation,
including a consecutive 401 in the key pool.
The peek recognizes root, `error` and
`last_error` codes, preserves an observed code through a later failed read, and leaves the raw
response available for quota observation. A refusal stops both same-key and pool recovery.

Kiro endpoint fallback and throttle recovery, sidecar recovery, Google HTTP retry and repair,
the transient ladder's 429 handoff, and the reset-only 429 paths treat a size-limited, timed-out
or failed body probe as insufficient evidence for another send. They preserve the original body
and quota provenance while blocking recovery. Kiro's client formatter applies the retry veto.
The bounded HTTP probe also treats SSE data fields as inconclusive when a gateway omits or
mislabels the media type. CR, LF and CRLF delimit fields, including after comments and blank lines.
An independently replay-safe transient operation
keeps its explicit exception. In `src/web-search/header-deadline.ts`, local pacing and bounded
post-header body inspection pause the iteration's cumulative response-header clock; caller
cancellation remains active. Uncertain body classification never authorizes a resend.

For an inconclusive HTTP error probe on a replay-unsafe request, including 401, 402, 403, 429
and transient 5xx, the retry path records
a client veto in process and keeps the original status, body and headers available for quota
observation. Responses and Compact, native and translated Chat, and managed native and translated
Messages project the veto as `x-should-retry: false` and omit `Retry-After`. Responses withholds
the upstream diagnostic text in its non-replayable error projection. Compact keeps the original
account's quota evidence when this check blocks a 402 account move. Kiro also checks for a
recognized public refusal code during bounded client formatting when the header has already
vetoed a resend.

Native and translated Responses record a genuine no-retry 429 against the sending OAuth
account's cooldown without selecting another credential. Native Responses also records the sent
generation's model denial. A no-retry verdict does not suppress fenced
revoked/verify-account bookkeeping or effort-pending cleanup. Native Anthropic OAuth attributes
a genuine 429 to the credential that sent the request even when the directive prevents rotation.
The Anthropic error formatter preserves the exact directive and omits `Retry-After`.
Native Messages passthrough also preserves an explicit upstream veto on a body-stall 504 or a
body-cap 502.

## Replacement and preflight boundaries

A pre-header reset replacement with a no-retry directive keeps the original replacement
response through quota observation. A native post-header replacement retains its probed
wire code through a failed body reread, subject to caller cancellation. The protocol replacement
selector distinguishes a recognized refusal from an inconclusive probe: an unusable replacement
is cancelled, and an operator replacement that invites another send settles as the fixed refusal.
A genuine replacement 429 with an explicit upstream retry veto keeps its withheld-diagnostic
envelope after quota observation. A recognized refusal code still selects the fixed refusal.
The selector also keeps the fixed projection of a verified
[xAI Legacy 403](../providers/xai-grok.md#legacy-privacy-mode-403).

Combo preflight checks both `error` and `last_error` on the root and nested response. A recognized
refusal outranks a generic sibling error. Bare error frames and wrapped failed terminals with
`retryable: false` bypass caller-supplied recovery classifiers, including opaque-state recovery.
Usage ownership remains with the native tap or bridge when present.

When an emergency compaction attempt carries a replay veto, compaction recovery publishes a
fixed HTTP or buffered failed-terminal envelope with the client veto. Only exact public error
codes can survive projection.

## Terminal continuation delivery

`src/server/responses/adapter-continuation.ts` applies the same replay verdict to HTTP
errors and parsed error events. A recognized code in an error envelope selects HTTP 429
where the client uses an HTTP error status. An explicit header or body veto or an
inconclusive bounded probe selects fixed text with the original error status. A parsed
error without a status uses 502 for the uncoded veto. Choice-level Chat failures inherit
the enclosing retry verdict, and buffered Anthropic errors retain a valid error status.
A continuation body read or parse failure retains an explicit header or already observed
verdict. Responses keeps its failed terminal
envelope, and buffered Responses adds the client veto header. Both Chat encoders and the
translated Messages paths preserve the verdict in the terminal, and their buffered folds
return the error status with `x-should-retry: false` and no Retry-After. Quota observation
uses the physical send's response, and parsed usage is observed before fixed error projection.

## Anthropic image recovery

`src/server/responses/image-context-recovery.ts` requires a conclusive 413 probe before a
summary send. A larger bounded delivery read can still project a trailing refusal code.
A refusal on the summary stops the image resend. Already observed summary usage still settles
its physical-send receipt before fixed error projection, and internal summary text never becomes
the requested answer. A parser failure cannot erase an already recognized refusal code.
`tests/responses/responses-anthropic-image-context-recovery.test.ts` covers the direct, search and
media paths, header and body verdicts, the bounded probe boundary and observed-usage settlement.

## Transient retry and bounded error inspection

`src/lib/upstream-retry.ts` accepts finite numeric Retry-After seconds, including fractions, or dates
accepted by `Date.parse`. Negative delays and past dates give zero.
`src/lib/upstream-retry.ts` owns the retry constructors. For a transient 5xx, `fetchWithTransientRetry`
does not resend a response whose bounded body prefix proves context overflow. It reads at most 16,384
bytes from a clone within 250ms or until cancellation, leaving the returned body intact.
A conclusive probe without a refusal or overflow verdict retains the normal retry. For replay-unsafe requests, see [inconclusive probes](replay-refusals.md#resend-and-quota-evidence).
Hypothetical, negated, question-form and configuration-failure mentions are excluded per sentence
so they cannot hide a definite overflow in another sentence. A throttle worded only as
"too many tokens" is not a verdict. An explicit "prompt is too long" remains a verdict when no throughput signal is present.
Body inspection time does not count toward the upstream slow-attempt budget, and empty chunks cannot
starve the deadline or cancellation. `tests/lib/upstream-retry.test.ts` covers retry and cancellation.
Before a spend-guarded retry, paced responses release their body lease by retaining bounded raw bytes via an optional caller-supplied reader.
The retained body carries read failures for the receiver's usual error policy, and retry accounting keeps the upstream status. The shared detector handles negation asides in bounded time; `tests/lib/definite-overflow-verdict.test.ts` covers its classification and abort-timer responsiveness.

Buffered Responses delivery treats an error-bearing `response.completed` as a failed turn.
A recognized refusal code on the event, snapshot, or one of their error carriers establishes failure on completion.
Buffered coded completions and incomplete snapshots use HTTP 429 with the client veto header and omit Retry-After.
Streamed `response.completed` and `response.incomplete` use the buffered completion's error
classifier on both carriers. A nonblank string or a record with a nonblank type, code, or message
is meaningful. A veto alone leaves an otherwise clean completion unchanged.
An explicit retry veto on a generic failed completion preserves its failure status and code,
withholds the upstream diagnostic, and sends `x-should-retry: false` without `Retry-After`.
Combo preflight and WebSocket cache-miss recovery both honor
`incomplete_details.retryable: false` on the event or response snapshot before recovery.
