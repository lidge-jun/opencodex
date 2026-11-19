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
Image dispatch distinguishes a deadline before a physical send from one after that POST left;
only the latter becomes a replay refusal. A Messages inference refusal uses HTTP 429 and the
Anthropic envelope. The `count_tokens` deadline returns 504. Safe GET/HEAD and unrelated
TimeoutErrors retain their existing status.

Native and translated HTTP delivery preserve the fixed 429 envelope, exact code and
`x-should-retry: false` across JSON rewraps, including combo and Messages conversion.
The envelope omits `Retry-After`. The translated Messages collector preserves this policy
when a Responses SSE terminal pairs a recognized refusal code with `response.retryable: false`.
`src/server/responses/non-replayable-error.ts` sets that flag and preserves the exact public
codes on native Responses failed terminals while replacing upstream diagnostics with fixed
text. The upstream-owned `upstream_no_response` and `upstream_closed_before_response` retain
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

The shared predicate gates retries, credential recovery and same-request fallbacks. Kiro
and Google HTTP check the directive and a bounded peek for refusal codes before adapter
resends. Google keeps original evidence when raw errors are requested; display normalization
retains the veto and projects recognized codes to the fixed refusal. Native Chat, Responses,
Compact, Messages, continuation and sidecar paths also honor the veto.
The transient ladder checks 429s even at budget exhaustion. Native Messages checks its
reset-only path too. The peek recognizes root, `error` and `last_error` codes, preserves an
observed code through a later failed read, and leaves the raw response available for quota
observation. It stops both same-key and pool recovery.

Sidecar recovery and the transient ladder's 429 handoff treat a size-limited, timed-out or
failed body probe as insufficient evidence for another send. They preserve the original body
and quota provenance while blocking recovery. An independently replay-safe transient operation
keeps its explicit exception. In `src/web-search/header-deadline.ts`, local pacing and bounded
post-header body inspection pause the iteration's cumulative response-header clock; caller
cancellation remains active. Uncertain body classification never authorizes a resend.

Native Responses also records the sent generation's model denial and generic OAuth cooldown
without selecting another credential. A no-retry verdict does not suppress fenced
revoked/verify-account bookkeeping or effort-pending cleanup. Native Anthropic OAuth attributes
a genuine 429 to the credential that sent the request even when the directive prevents rotation.
The Anthropic error formatter preserves the exact directive and omits `Retry-After`.

## Replacement and preflight boundaries

A pre-header reset replacement with a no-retry directive keeps the original replacement
response through quota observation. A native post-header replacement retains its probed
wire code through a failed body reread, subject to caller cancellation. The protocol replacement
selector distinguishes a recognized refusal from an inconclusive probe: an unusable replacement
is cancelled, and an operator replacement that invites another send settles as the fixed refusal.
The selector also keeps the fixed projection of a verified
[xAI Legacy 403](../providers/xai-grok.md#legacy-privacy-mode-403).

Combo preflight checks both `error` and `last_error` on the root and nested response. A recognized
refusal outranks a generic sibling error, and caller-supplied retry classifiers cannot override
it. Usage ownership remains with the native tap or bridge when present.

## Anthropic image recovery

`src/server/responses/image-context-recovery.ts` checks the complete bounded 413 payload again
before a summary send, because the earlier small probe can omit a trailing refusal code.
A refusal on the summary stops the image resend. Already observed summary usage still settles
its physical-send receipt before fixed error projection, and internal summary text never becomes
the requested answer. A parser failure cannot erase an already recognized refusal code.
`tests/responses/responses-anthropic-image-context-recovery.test.ts` covers the direct, search and
media paths, header and body verdicts, the bounded probe boundary and observed-usage settlement.
