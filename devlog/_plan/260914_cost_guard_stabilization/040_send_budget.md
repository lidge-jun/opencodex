# 040 — wp4: one logical request, one send budget

## Today

#2981 already found and fixed one instance of this: transient retry and
socket-reset retry nested, so `attempts=3` became up to nine physical sends, and
the fix introduced a shared total-send budget inside the send helper. The lesson
did not generalise. The layers that can each re-send one logical request are still
counted separately: SDK/transport retry, adapter retry, stream recovery and
continuation repair, account failover, and combo failover. Multiplied rather than
summed, a single user turn can reach upstream many more times than any one layer's
configuration suggests, and each one of those sends carries the full prompt.

That is the second multiplier behind #4546. Routing decided *where* the cold
prefix went; retry decided *how many times* it was sent.

## The rule

One logical request carries one total send budget, and every layer decrements it.
A conservative starting policy: at most three total upstream sends per logical
request, of which at most one may be a cross-account move. `Retry-After` is a lower
bound, never shortened by a local maximum delay — #3294 and #3606 already
established that rate limiting and usage exhaustion are different answers and that
5xx bodies can carry quota information worth preserving. A pool-wide retry **ratio**
cap sits above the per-request budget, following the standard overload guidance
that per-request attempt limits alone do not prevent a retry storm.

What this cannot do is bound a client that re-sends on its own. That needs a shared
logical-request identity with the client, which is out of scope here and noted so
the budget is not mistaken for a total guarantee.

## Evidence to add

Sends per logical request, and input tokens spent on retries, aggregated per root
workflow. `sendCount` already counts physical sends per attempt but never reaches
`/api/usage` or the GUI. Surfacing it is what turns "we think retries amplified
this" into a number.
