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
5xx, and **12** across a three-target combo.

An audit round corrected four claims an earlier draft of this section got wrong, and
the corrections change the design, so they are recorded rather than quietly fixed.

**The #2981 budget is not the opt-in part.** `fetchWithTransientRetry`
(`src/lib/upstream-retry.ts:400`) shares one total-send allowance between the
socket-reset and 5xx layers **per helper call**, not per logical request. The
opt-in-and-key-auth restriction belongs to `transientRetryPolicyFor`
(`src/providers/key-failover.ts:314`), which is a different thing. Codex passthrough
always calls the helper with no `attempts` and no `onSendsConsumed`
(`src/server/responses/core.ts:5488, 5570, 5790, 5885`), so every recovery leg gets a
fresh default of 3. The 4/7/12 numbers come from that passthrough default.

**The account re-send is not `applyFailureFailover`.** That function only selects and
promotes (`src/codex/routing.ts:2260`). The same-request resend is
`retryCodexPoolOnAlternateAccount` (`core.ts:1645`), which calls
`fetchWithHeaderTimeout` directly. That is the "+1 alternate" in the measured 4.

**Continuation repair is already covered on the policy path** via
`remainingTransientSendBudget` (`core.ts:8302`). What actually escapes is
empty-completion (`core.ts:7316`) and Codex passthrough, which has no continuation
budget at all. Also escaping, and missing from the earlier list: `rebuildAndRefetch`
for opaque-blob / reasoning-effort / console-go, compact
(`src/server/responses/compact.ts:870`), generic OAuth hops
(`GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST = 3`), and the adapter retries in
`src/adapters/kiro-retry.ts` and `src/adapters/cursor/transport-retry.ts`.

**`Retry-After` is already shortened**, so treating it as a lower bound is a behavior
change to argue for, not a gap to close: `retryBackoffDelayMs` does
`Math.min(retryAfter, opts.maxDelayMs)` (`upstream-retry.ts:230`) against 5s transient
and 1s reset, same-target 429 waits cap at 60s (`key-failover.ts:341`), and combo/key
cooldown parsers cap at 10 minutes (`src/combos/failover.ts:131`).

The shape to build, in order:

0. **Start by making the existing budget owner cover the passthrough.** `handleResponses`
   already declares one at `src/server/responses/core.ts:7554-7560`, and its own comment says
   it is declared there "so BOTH the initial send and the later recovery refetches share it."
   That holds for the adapter path. It does **not** hold for the Codex passthrough legs at
   `:5488`, `:5570`, `:5790` and `:5885`, which sit in an earlier scope in the same function
   and pass neither `attempts` nor `onSendsConsumed` -- so each takes the helper's fresh
   default of 3. The measured 4/7/12 come from that gap, not from a missing mechanism, which
   makes hoisting the owner the smallest change that removes fresh-per-leg. It also preserves
   the 3 same-account + 1 cross-account shape the audit warned a flat ceiling would break,
   because the cross-account send goes through `retryCodexPoolOnAlternateAccount` and is not
   a transient attempt at all. Keep the `Math.max(1, budget - used)` floor for this step: it
   is what lets a later leg make progress, and removing it is step 3's separate problem.

1. **Use the seam that already exists.** `HandleResponsesOptions` is what combo
   already threads (`comboAttempt`, `translatorBudget`, `comboReplaySnapshot`); the
   budget belongs there and must be passed into `retryCodexPoolOnAlternateAccount`.
   `TransientRetryOptions.onSendsConsumed` is the helper's existing sharing hook.
   Adapter retries only see it if it also rides `AdapterFetchContext`
   (`src/adapters/base.ts:131`). `logCtx.activeAttempt.sendCount` is observational and
   splits per combo child, so it must not become the limiter.
2. **Every re-send decrements it**, covering the escaping paths listed above. A layer
   that cannot see the budget will reintroduce the multiplier.
3. **Removing the floor is not one change but three.** Dropping the
   `remainingTransientSendBudget` floor (`core.ts:7552`) does not stop a send, because
   both helpers still coerce with `Math.max(1, attempts)`
   (`upstream-retry.ts:358, 404`). Continuation after a spent initial budget, the
   combo hop after the first target, and 429 `rebuildAndRefetch` currently depend on
   that floor to make progress at all, so each needs an explicit refusal path. Native
   Chat already fails closed at 0 (`src/server/chat-native.ts:305`) but throws a
   synthetic error rather than returning the last upstream answer; pick one contract
   and make both paths use it.
4. **The ceiling cannot be 3.** Today's own Codex 5xx recovery is 3 same-account plus
   1 alternate, so a 3-send cap silently breaks a working path. Budget the
   same-account attempts and the cross-account move separately, and treat 401-then-5xx
   and multi-target combo as deliberate policy decisions rather than fallout.
5. **A pool-wide retry ratio cap** above the per-request budget, because per-request
   limits alone do not prevent a retry storm.

Out of scope and worth stating: a client that re-sends on its own is not bounded by
any of this. That needs a logical-request identity shared with the client.

Verification is hosted CI only, as for the rest of this unit. The regression that
matters is a table test: for each failure shape (5xx streak, 401-then-5xx, combo
fan-out), assert the exact number of upstream sends, because the defect is a count.
That is observable today on the Codex, passthrough and combo paths --
`noteAttemptSend` already increments `sendCount` per physical thunk
(`src/server/request-log.ts:1310`) and existing tests assert it -- by summing
`logCtx.attempts[].sendCount` across combo children. It is **not** observable for the
Kiro and Cursor inner retries, which call `noteAttemptSend` once before dispatching,
so those need instrumentation before their counts can be pinned.
