# wp3 — Devin cloud-direct hardening

Branch: codex/260912-devin-cloud-direct-hardening (base codex/260912-devin-cli-token-transition)

## 1. Usage is decoded from the display field, not the usage field

This is the defect the user can see, and it is confirmed against the reference proto.

decodeUsageBlock in src/adapters/devin/cloud-direct/chat.ts treats GetChatMessageResponse
field 28 as a usage block keyed by metric-id strings. In the Cognition schema carried by
can1357/oh-my-pi:

    GetChatMessageResponse.usage                      = 7   (ModelUsageStats)
    GetChatMessageResponse.response_dimension_groups  = 28  (repeated ResponseDimensionGroup)

    ModelUsageStats.input_tokens       = 2   uint64 varint
    ModelUsageStats.output_tokens      = 3   uint64 varint
    ModelUsageStats.cache_write_tokens = 4   uint64 varint
    ModelUsageStats.cache_read_tokens  = 5   uint64 varint

Field 28 is not an older usage shape. It is the current display message:
ResponseDimensionGroup is {title, dimensions}, and ResponseDimension.uid is field 5 — which is
exactly the sub-field today's decoder reads as metric_id. So the existing decoder works by
reading presentation rows whose uid happens to spell the metric, and it yields cache numbers
only when the server chose to render cache rows. Field 7 carries them unconditionally.

Three consequences the first draft of this plan got wrong, corrected after audit:

- Field 7 is uint64 varints. The existing entry walker only descends length-delimited
  sub-messages and reads a fixed32 float, so it cannot read field 7 at all. Field 7 needs its
  own decoder.
- "Decode both, field 7 wins" is not what decoding both produces. Both fields arrive in the
  same response and src/adapters/devin.ts replaces usage on every usage event, so a naive
  addition lets field 28 land last and win. Within one message, field 7 must suppress
  field 28 outright; field 28 stays only as the fallback for a message that carries no field 7.
- The adapter must merge usage fields across events rather than replacing the object, so a
  later partial frame cannot zero an earlier input count.

## 2. Whether input_tokens already includes cache is not known, so do not assume it

This repository's convention is inclusive: inputTokens covers the whole prompt, cachedInputTokens
is the read subset, and totalTokens is input + output with no cache added on top. Adapters split
on what the wire gives them — anthropic.ts and kiro-events.ts fold cache into input because their
wire format is exclusive, while openai-responses.ts passes input_tokens through because it is
already inclusive.

oh-my-pi summing input + output + cacheRead + cacheWrite is evidence that Devin might be
exclusive. It is not proof, and guessing wrong in the inclusive direction silently inflates
input and bills cache at the uncached rate, because normalizeCostTokens only rejects
read + write > input.

So the mapping is derived from the frame rather than assumed:

    if (input >= cacheRead + cacheWrite) inputTokens = input          // already inclusive
    else                                 inputTokens = input + cacheRead + cacheWrite

Both branches converge on the right answer for the case that prompted this work — a 58k prompt
that is 57k cache read and 1k fresh reads as 58k total with a 57k cached subset whichever
convention the wire uses — and neither branch can produce read + write > input. The heuristic
is written down in the code with that reasoning, and replaced with a fixed mapping the moment a
live ModelUsageStats frame settles the question.

## 3. An HTTP status never reaches the classifier

CloudChatError is thrown as "GetChatMessage failed (HTTP <status>)" with no status field, so a
401 on a revoked import is a generic adapter failure rather than an authentication error, and
inferHttpStatusFromAdapterMessage turns an HTTP 429 into a 502 — which means core's failover
never rotates or backs off. Fix: carry status on the error and map 401, 403, 429 and 5xx.

## 4. A client abort is reported as an upstream failure

The adapter emits "Devin turn was aborted." with no status, and isClientClosedMessage does not
recognise that wording, so a cancelled turn infers 502. Fix: emit the phrase the classifier
already knows, with status 499.

## Verification

bun test tests/providers/devin-adapter.test.ts tests/providers/devin-hardening.test.ts
