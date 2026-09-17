# wp1 — #4865, adapter-owned sends and the request budget

## The question

Three adapter retry ladders reached upstream without asking the request's send budget. The PR
routes them through `ctx.sendBudget`. The question for this lane is not whether that is a good
idea; it is whether the resulting accounting is exact in all three directions: one physical send
charged once, a send that never happens charged never, and a refusal that stays visible.

## What the helper actually guarantees

`createAdapterPhysicalSend` (`src/adapters/physical-send.ts`) reserves once per call and hands the
adapter an executor that can be used at most once.

**One send, one charge.** The reservation happens before anything else, and the inner executor
carries a `dispatched` latch alongside `permit.use()`. A second call into the same executor throws
`SendBudgetExhaustedError` instead of quietly sending twice on one reservation. The charge itself
is not deferred to `use()` — `reserveDispatch` in `src/lib/request-execution-budget.ts` books the
spend at reservation time on purpose, because deciding and charging separately let two legs read
the same remainder and both dispatch.

**No charge for a send that did not happen.** `permit.release()` in the `finally` returns the
booking whenever the permit was never used, and `release()` is a no-op once settled. Every exit
before dispatch — an aborted signal at entry, an abort observed after pacing, an abort observed
after `beforeDispatch`, or a throw from `beforeDispatch` itself — therefore refunds.

**The order of operations is the load-bearing part.** Admission precedes the executor's pacing
slot, the backoff sleep, the JWT refresh and the cancellation of a superseded response, all of
which the PR moved behind `beforeDispatch`. A refused retry consequently pays neither a pacing
queue slot nor a backoff wait.

**A refusal is not swallowed.** Each ladder catches `SendBudgetExhaustedError` and returns the
last real upstream response, with its status, `Retry-After` and quota body intact. That is the
established exhaustion contract, not a silent success: a refusal that never reached upstream at
all propagates, and `src/server/responses/adapter-dispatch.ts` answers it as `429` with
`SEND_BUDGET_EXHAUSTED_CODE` rather than mislabelling it `502` — which matters because the Codex
client retries `5xx` and does not retry `429`.

**No double counting.** `onPhysicalSend` is observation only. `noteAdapterPhysicalSend` in
`src/server/responses/request-send-budget.ts` ignores ordinal 1 and records an attempt send for
the rest; it never touches the counter.

## One defect found

In `src/adapters/mimo-free.ts` the 401 replay drains the first response *after* refreshing the
JWT:

```
resetMimoJwtCache();
const freshJwt = await getMimoJwt(ctx?.abortSignal);
retryHeaders = { ... };
try { void response.body?.cancel().catch(() => {}); } catch { /* already consumed */ }
```

`getMimoJwt` performs its own network call and can throw. When it does, the error leaves
`fetchResponse` and the 401 response body is never drained — a leak the pre-change code did not
have, because it cancelled first and refreshed second.

The fix is to restore that ordering inside `beforeDispatch` rather than outside it. The drain has
to stay behind admission: if the budget refuses the replay, the ladder returns that same 401
response to its caller and its body must still be readable. Cancelling first *within*
`beforeDispatch` satisfies both, because `beforeDispatch` only ever runs after admission.

## Two things that look like defects and are not

**The google-http 429 peek now always clones.** It reads
`const peekTarget = res.clone()` where it used to read `res` directly unless `returnRawErrors` was
set. This is required: `pendingResponse` may have to be returned later, so the original body has
to survive the peek. It is also observationally identical on the quota-exhausted path, because
`formatMessage` already falls back with `payloadText || peek`. Before the change
`normalizeUpstreamHttpErrorResponse` re-read an exhausted body and got `""`, then used `peek`;
after it, `payloadText` is the same text `peek` holds.

**The final `throw lastError ?? new Error(...)` cannot strand a `pendingResponse`.** Every
retryable-status path returns a normalised response on the last attempt, and every retry drains
the previous response in `beforeDispatch` before dispatching. The remaining exit is an abort,
which is already a discarded request.
