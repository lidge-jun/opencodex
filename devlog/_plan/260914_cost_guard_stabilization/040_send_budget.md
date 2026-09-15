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
## Step 0 status

Landed. The owner turned out to live in `handleResponsesInner`, not the `handleResponses`
wrapper, and the four passthrough sends sit inside the same outer try -- so the declaration was
in the temporal dead zone for them and a reference-only change would have thrown at runtime.
The fix hoists the three bindings above the passthrough branch and wires all four sends with
`attempts: remainingTransientSendBudget(TRANSIENT_RETRY_MAX_ATTEMPTS)` and `onSendsConsumed`.

The trap an audit round caught before it was written: do NOT copy the adapter's
`transientRetryPolicyFor(...) ? ... : {}` gate onto these sites. That function returns null for
Codex forward auth, so the copy would have made the whole change a silent no-op.

Consequence to expect in the logs: an initial 401 now spends one of the three, so a later 5xx
streak on the refresh leg gets two rather than a fresh three. Combo stays at 12 until the budget
rides `HandleResponsesOptions`, because each child runs its own `handleResponsesInner`.

Verification is hosted CI only, as for the rest of this unit. The regression that
matters is a table test: for each failure shape (5xx streak, 401-then-5xx, combo
fan-out), assert the exact number of upstream sends, because the defect is a count.
That is observable today on the Codex, passthrough and combo paths --
`noteAttemptSend` already increments `sendCount` per physical thunk
(`src/server/request-log.ts:1310`) and existing tests assert it -- by summing
`logCtx.attempts[].sendCount` across combo children. It is **not** observable for the
Kiro and Cursor inner retries, which call `noteAttemptSend` once before dispatching,
so those need instrumentation before their counts can be pinned.

## Step 1 status, and six corrections the next audit round produced

Step 1 landed (`7f9284ab1e`): `sendBudget` rides `HandleResponsesOptions`, is minted once at
ingress (`core.ts:3461`) and inherited by a combo child through the existing options spread
(`core.ts:3113`). Six findings from the follow-up audit change what comes next, so they are
recorded rather than quietly folded in.

**The combo fix is half a fix.** A child inherits the *counter* but the adapter initial send
never reads it as a *limit*: `core.ts:7656` passes `attempts: transientPolicy.attempts` raw.
The oracle's own comment justifies that with "nothing has been spent yet", which is true for a
first turn and false for combo target 2. So target 1 can spend the budget and target 2 still
draws a fresh full policy allowance. Until `:7656` draws the remainder like every other leg,
the measured 12 does not come down.

**The cross-account move is not merely unbudgeted, it is unbounded per request.**
`retryCodexPoolOnAlternateAccount` is at `core.ts:1434` (not `:1645`), and it sends directly
with `fetchWithHeaderTimeout` at `:1626` inside a loop whose `maxRetrySends` is 1 for a real
alternate but **7** for the same-account gated-400 ladder. The important part is the caller:
it sits inside `passthroughRecovery: for (;;)` (`:5628`), `excludeAccountId` excludes only the
account that just failed (`:1492`), and no per-request flag records that a move already
happened. Sequential account moves are bounded today by pool exhaustion and cooldowns, by
nothing else. A flat `used` counter does not close that; a separate move counter does.

**`fetchWithResetRetry` has no counting seam at all.** `onSendsConsumed` lives only on
`TransientRetryOptions` (`upstream-retry.ts:304`) and fires only from `fetchWithTransientRetry`
(`:479`). Every leg that falls back to reset-only retry -- the non-policy adapter initial send
and every `rebuildAndRefetch` recovery kind when `refetchTransientPolicy` is null -- is
*uncountable*, not just uncounted. Step 2 therefore starts by giving `ResetRetryOptions` the
same callback, not by adding call-site wiring.

**There is a fourth floor.** Besides `core.ts:4995` and `upstream-retry.ts:374, 420`, the
inner `remaining = () => Math.max(1, budget - sent)` at `upstream-retry.ts:439` re-floors the
reset call. Removing the three named sites still lets a spent budget send once.

**The exhaustion contract is already decided by the codebase, twice.** `fetchWithTransientRetry`
returns the last response with its body intact when the budget runs out (`:476`), and the
reachable native-Chat path preserves the terminal 429 (pinned at
`tests/responses/chat-completions-endpoint.test.ts:1553, 1597`). The synthetic throw at
`chat-native.ts:308` is an unreachable backstop, not the policy. Return-the-last-answer is the
contract; a throw would hide the status, the `Retry-After` header and any quota body -- exactly
the evidence #3294/#3606 said to preserve. The throw stays only as a typed backstop for a
caller that forgot to check.

**`sendCount` already reaches the wire.** The claim above that it "never reaches /api/usage or
the GUI" is wrong. It is a required persisted field (`src/usage/log.ts:100`), it survives the
whitelist normalizer (`:465`), `/api/logs` spreads it (`src/server/management/shared.ts:222`)
and the GUI already types it (`gui/src/pages/Logs.tsx:126`). What is missing is rendering (the
attempts table has no column) and aggregation (`summarizeUsage` counts attempts, never sends).

## Delivery slices

Steps 2-5 are not one diff. Verification here is hosted CI only, so a slice that breaks forty
pinned counts at once is undiagnosable. They ship in this order, one PR each:

- **Slice A (this cycle).** Split the budget and close the two holes that need no new plumbing:
  `TransientSendBudget` gains `accountMoves` with `CROSS_ACCOUNT_MAX_SENDS = 1`;
  `retryCodexPoolOnAlternateAccount` charges a move and refuses a second one with the existing
  `{ kind: "no-alternate" }` path after `recordUnmovedTransientOutcome()`; the adapter initial
  send at `:7656` draws `remainingTransientSendBudget(transientPolicy.attempts)`. The split has
  to come first because step 2 without it collapses the working 3 same-account + 1 alternate
  shape that `tests/responses/responses-compaction-routing.test.ts:1346` pins.
- **Slice B.** `onSendsConsumed` on `ResetRetryOptions`, unconditional wiring at `:7652` and
  `:7775`, `sendBudget` on `HandleResponsesCompactOptions`, and the empty-completion /
  `runTurnAttempt` charge at `core.ts:7346`.
- **Slice C.** All four floors to `Math.max(0, ...)` plus the refusal contract above, with the
  pinned counts in `responses-opaque-blob-recovery.test.ts` rewritten to the refusal shape.
- **Slice D.** The pool-wide retry ratio cap and `sendCount` aggregation.

Kiro (up to ~18 sends per call, ~36 with the text fallback) and Cursor ride
`AdapterFetchContext`; that field must be optional and unlimited by default or every adapter
unit test that calls the transport context-free breaks.

## Slice A landed, and the four counterexamples that shaped it

PR #4609 carries the guarded profile from the PRD: four model sends per logical request, a base
allowance of three, and one final-recovery reserve that an account move and a validated rebuild
share. An adversarial audit round found four things that would have shipped as defects.

**Charging the same send twice.** `permit.use()` increments `used`, and `onSendsConsumed`
increments it again for anything routed through the retry helper. A four-send cap would have
behaved as a two-send cap and every acceptance row would have been off by a factor of two. The
intent now carries `countedExternally`, so a helper-routed permit books the reserve and the
alternate-target ledgers but leaves `used` to the reporter.

**Removing the floor kills a recovery the PRD wants kept.** The pinned sanitized-rebuild case
at `responses-opaque-blob-recovery.test.ts:600` is three 502s plus one rebuild, and its own
comment says the rebuild "draws on what is LEFT of that same budget" -- which is the floor. With
the floor gone the rebuild gets zero and the request dies at three. `recoverySendAllowance`
spends the base allowance first and only then draws the reserve, which is what keeps that fourth
send alive for the right reason instead of by accident.

**The exhaustion contract is a call-site problem.** A typed throw inside the helper cannot
restore a body the caller already cancelled, and every catch on these paths launders a rejection
into 502 `upstream_error`. So the OAuth 401 replay and the same-target 429 wait check the
remainder in their own conditions, before the cancel, and an exhausted request returns the real
401 or 429 with its `Retry-After`. The typed error stays only as the backstop for a leg that
never had a prior response.

**Reserving too early burns the slot on a request that never moved.** The same-account
gated-model 400 ladder runs through the same function and is bounded at eight sends by
`maxRetrySends`. Reserving before `retrySameConfirmedAccount` is known would have spent the
single failover slot on it. The reservation is guarded on `!retryAuthCtx`, which the ladder has
already set.

Residual, accepted rather than hidden: `maxTargetTransitions` and `maxAlternateTargetSends`
would refuse the pinned three-target combo hop, so combo hops are not wired to
`reserveDispatch` in this slice and those fields are exercised only by the account-failover
path. Wiring combo needs a per-target policy, not a per-request transition cap. Compact, Kiro,
Cursor and the generic OAuth hops still hold their own allowances.
