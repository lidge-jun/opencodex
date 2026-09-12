# wp3 — Devin cloud-direct hardening

Branch: codex/260912-devin-cloud-direct-hardening (base codex/260912-devin-cli-token-transition)

## 1. Usage is decoded from the display field, not the usage field

This is the defect the user can see, and it is confirmed against the reference proto rather
than inferred.

decodeUsageBlock in src/adapters/devin/cloud-direct/chat.ts treats GetChatMessageResponse
field 28 as a UsageStats block keyed by metric_id strings. In the Cognition schema carried by
can1357/oh-my-pi:

    GetChatMessageResponse.usage                      = 7   (ModelUsageStats)
    GetChatMessageResponse.response_dimension_groups  = 28  (repeated ResponseDimensionGroup)

    ModelUsageStats.input_tokens       = 2   uint64
    ModelUsageStats.output_tokens      = 3   uint64
    ModelUsageStats.cache_write_tokens = 4   uint64
    ModelUsageStats.cache_read_tokens  = 5   uint64

ResponseDimensionGroup is {title, dimensions} — presentation rows for the IDE, with no
metric_id field at all. So our decoder is reading a display structure for numbers that live
one field away, and cache read and cache write essentially never arrive. That is why a Devin
row shows a bare total while other providers show the cached companion.

The fix is additive. Decode field 7 as the authoritative source; keep the field-28 decoder as
a fallback for any response that still carries the older shape; field 7 wins when both are
present. Nothing that works today can regress.

Token semantics follow this repository's convention rather than oh-my-pi's: inputTokens is
the full prompt including cache, cachedInputTokens is the read subset, and
cacheCreationInputTokens is the write subset. oh-my-pi sums the four into a total because its
own convention is exclusive. Ours is inclusive, so input becomes input + cacheRead + cacheWrite
and total stays input + output.

## 2. An HTTP status never reaches the classifier

CloudChatError is thrown as "GetChatMessage failed (HTTP <status>)" with no status field, so
a 401 on a revoked import is classified as a generic adapter failure rather than an
authentication error, and the account is never marked as needing re-auth. isAuthenticationMessage
has no needle for it. Fix: carry status and the Connect code on the error, and classify
401 as authentication, 429 as rate limit, 5xx as upstream.

## 3. An account cap is reported as 403

A trailer permission_denied carrying "Your limit will reset in N minutes" is a quota refusal.
Classified as 403 it invites the client to retry straight into a live cap, and our
parseRetryAfterFromMessage only understands "try again in Ns" and "retry after N". Fix: parse
the reset window, classify as 429, and carry a Retry-After.

## Verification

bun test tests/providers/devin-adapter.test.ts tests/providers/devin-hardening.test.ts
