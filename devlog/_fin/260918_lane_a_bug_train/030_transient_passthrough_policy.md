# #4893 — the Responses passthrough lane could not read its own retry policy

## What was wrong

Three source facts compose into the defect, and all three held at `origin/dev` `2f025814f3`:

1. `transientRetryPolicyFor` admitted `openai-chat` only.
2. `createResponsesPassthroughAdapter` sets `passthrough: true`, and `core.ts` returns into
   `executePassthroughResponse` on that flag — before `createAdapterContinuations` or the adapter
   dispatch path is constructed, so the three call sites that read the policy are unreachable for
   this adapter.
3. `passthrough-dispatch.ts` did not import the function at all. Four sites passed the constant
   `TRANSIENT_RETRY_MAX_ATTEMPTS`: the initial send, the OAuth-401 replay, the same-target 429
   replay, and the validated-rebuild leg. Two more asked `sendBudgetExhausted()` at the same
   constant.

So the lane was never missing transient replay. It had an unconditional one that no provider
setting could tune in either direction, while the same provider on `openai-chat` was tuned
normally. That asymmetry is what makes it a defect rather than an undocumented default.

## Why widening the gate is not the fix

PR #4800 widens `transientRetryPolicyFor` to admit `openai-responses`. Necessary, not
sufficient: the lane does not call that function, so with #4800 alone the reproduction is
unchanged at three sends. This change carries #4800's gate edit with a `Co-authored-by` trailer
and wires the lane to it.

## The two boundaries the constant was insulating

**Budget accounting.** `remainingTransientSendBudget(cap)` resolves to
`RequestExecutionBudget.remainingBaseSends(cap)`, which is
`min(cap, baseSendAllowance - spent)`. `core.ts` builds every Responses request's budget from
`CODEX_TEXT_GUARDED_BUDGET_POLICY`, whose `baseSendAllowance` is 3.

The shape of that function matters, and getting it wrong is the one real trap here. `cap` bounds
what REMAINS, not what the request may spend in total. That is the right reading for the fixed
constant — every leg may ask for up to three, and the request-wide allowance is what actually
bounds the total — but `transientRetryOn5xx.attempts` is documented as the total for one request
including the first send. Passing the configured value straight through would silently turn it
into a per-leg ceiling, so a provider configured at one send would still reach upstream again on
a recovery leg. The first revision of this change did exactly that, and its own regression caught
it.

So `transientSendCapFor(configured, sendsUsed)` reduces the configured total by what the request
has already sent, and the result is then intersected with the base allowance. An absent policy
returns the constant unchanged, so a provider that configures nothing is byte-for-byte unaffected
at every call site.

That intersection is the deliberate settlement, and it answers the issue's question about whether
a provider "can now widen a request-wide bound". It cannot. Configuring below the allowance
narrows the request exactly — `attempts: 1` sends once and no recovery leg may dispatch, which is
the direction the reporter demonstrated as broken. Configuring above it does not raise the bound
that exists to stop per-request amplification (#4546).

Leaving that implicit would reproduce the original complaint one threshold higher, so it is
stated in the English reference and asserted in the regression. Raising `baseSendAllowance` per
provider is a policy decision about the guarded profile, not a wiring fix, and is deliberately
out of scope here.

Every leg had to move together. `sendBudgetExhausted()` asking at the constant while the sends
dispatch at a configured value would tell a provider with headroom it was spent, and would let
one configured below the constant pass the check and then be refused at the send. It now takes
the cap as a parameter, defaulted so every other caller is unchanged.

**The non-replayable boundary.** `isNonReplayableResponse` is checked inside
`fetchWithTransientRetry` and at each recovery branch, and is not a function of `attempts`.
Raising the configured value does not become a way to obtain the resend that marker forbids;
`tests/providers/upstream-transient-retry.test.ts` already pins a marked 504 returning after one
send under `attempts: 3`.

## Scope

`authMode` stays fail-closed, so the ChatGPT account pool (`authMode: "forward"`) still gets
`null` from the policy and keeps the default ladder it has always had. Only key-auth providers
on the two named adapters can tune anything.

## The separate symptom in the issue

The report also mentions a key-auth `openai-responses` provider terminating on its first send
with "interrupted with no error". This change does not explain that one and does not claim to:
the lane already retried three times, so a single send means something else ended the loop. The
four candidates the issue lists are still the right ones, and each is decidable from one captured
response. Left open.
