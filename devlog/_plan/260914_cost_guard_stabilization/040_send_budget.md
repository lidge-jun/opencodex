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

## Diff-level plan (wp4)

Measured today, per logical request: **4** sends on a default Codex 5xx (three
transient attempts plus one cross-account alternate), **7** when a 401 precedes the
5xx, and **12** across a three-target combo. The #2981 budget lives inside
`fetchWithTransientRetry` (`src/lib/upstream-retry.ts:400`) and is shared only
between the socket-reset and 5xx layers, only for opted-in key-auth `openai-chat`;
the Codex passthrough gets a fresh allowance per recovery leg, and
`remainingTransientSendBudget` floors at 1, so even the shared path still sends once
per hop after the budget is spent.

The shape to build, in order:

1. **A request-scoped budget object**, created once where the logical request is
   first identified and threaded through the call chain rather than re-derived per
   layer. It carries a total send allowance and a separate cross-account allowance.
   Starting policy: 3 total sends, at most 1 of them a cross-account move.
2. **Every re-send decrements it**, including the paths that escape the current
   helper: adapter retry, stream recovery and continuation repair, account failover
   in `applyFailureFailover`, and combo failover. A layer that cannot see the budget
   is a layer that will reintroduce the multiplier.
3. **The floor goes away.** Flooring at 1 means "budget exhausted" still sends. When
   the allowance is gone the request fails with the upstream's own last answer.
4. **`Retry-After` is a lower bound**, never shortened by a local maximum delay.
5. **A pool-wide retry ratio cap** above the per-request budget, because per-request
   limits alone do not prevent a retry storm.

Out of scope and worth stating: a client that re-sends on its own is not bounded by
any of this. That needs a logical-request identity shared with the client.

Verification is hosted CI only, as for the rest of this unit. The regression that
matters is a table test: for each failure shape (5xx streak, 401-then-5xx, combo
fan-out), assert the exact number of upstream sends, because the defect is a count.
