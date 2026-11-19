# Replay Refusals

## Client projection

`src/lib/upstream-retry.ts` defines two proxy-owned terminal codes. The historical
`upstream_reset_replay_refused` also covers a dispatched POST whose response-header deadline
caused fetch to fail. `src/client/link-relay.ts` uses `upstream_response_refused` when a limit
or caller abort rejects a resolved Home response. Both describe an exchange the upstream
may already have processed.

`src/server/responses/fetch-helpers.ts`, the Google adapter attempt wrapper and native
Anthropic Messages passthrough give caller cancellation precedence. A Messages inference
refusal uses HTTP 429 and the Anthropic envelope. The `count_tokens` deadline returns
504. Safe GET/HEAD and unrelated TimeoutErrors retain their existing status.

Native and translated HTTP delivery preserve the fixed 429 envelope, exact code and
`x-should-retry: false` across JSON rewraps, including combo and Messages conversion.
The envelope omits `Retry-After`. The translated Messages collector preserves this policy
when a Responses SSE terminal pairs a recognized refusal code with `response.retryable: false`.
`src/server/responses/non-replayable-error.ts` sets that flag and preserves the exact public
codes on native Responses failed terminals while replacing upstream diagnostics with fixed
text. The upstream-owned `upstream_no_response` and `upstream_closed_before_response` retain
their status and retry policy.

An explicit proxy-owned refusal keeps its terminal status and fixed message even when the
diagnostic resembles context overflow. A header-only directive blocks resends and leaves
definite overflow normalization and response ownership intact. Combo HTTP errors with the
directive use fixed text. The original local scope envelope requires the process-local
scope presentation marker.

## Resend and quota evidence

The synthesizing transport owns the in-process replay-refusal marker. Formatters carry it
across rewraps. Only the fixed-envelope constructor attests to the client body bytes, so
other rewraps still need client projection. An upstream wire code selects the fixed client
message and allowlisted headers. A wire directive blocks automatic resends when headers
arrive. Both signals preserve genuine upstream quota evidence.

The shared predicate gates retries, credential recovery and same-request fallbacks. Kiro
and Google HTTP check the directive and a bounded peek for refusal codes before adapter
resends. Native Chat, Responses, Compact, Messages, continuation and sidecar paths also
honor the veto. Native Chat projects the observed code alongside a nested diagnostic.
The transient ladder checks 429s even at budget exhaustion. Native Messages checks its
reset-only path too. The peek leaves the raw response available for quota observation.
Uncertain body classification never authorizes a resend.
Native Anthropic OAuth attributes a genuine 429 to the credential that sent the request
even when the directive prevents rotation. The Anthropic error formatter preserves the
exact directive and omits `Retry-After`.

A pre-header reset replacement with a no-retry directive keeps the original replacement
response through quota observation. A native post-header replacement retains its probed
wire code through a failed body reread, subject to caller cancellation. The selector also
keeps the fixed projection of a verified [xAI Legacy 403](../providers/xai-grok.md#legacy-privacy-mode-403).
