# 030 — Phase 3: compact endpoint alternate-account attempt (#913)

## The gap

`/v1/responses` already handles a pre-stream 429/402 by trying one eligible
alternate account inside the same logical request.
`retryCodexPoolOnAlternateAccount()` at `src/server/responses/core.ts:319-423`
excludes the first account, resolves an alternate, records and promotes the
rejected one, cancels the first body, rebuilds auth/provider/request, and sends
exactly once. It is activated before streaming at `:1679-1721`. Recognition is
narrow by design — only 429 and 402 (`:248-251`).

`/v1/responses/compact` has none of it. It resolves one context and builds one
set of headers (`src/server/responses/compact.ts:211-256`), performs one fetch,
buffers, records status, returns (`:275-319`). When the affined account returns
429, the client sees the rejection and retries the compact task *outside* the
logical request, which is how a session ends up reporting exhausted retries
while another pool account sat idle.

A second, smaller defect on the same path: `bufferCompactResponse()`
(`:120-156`) reconstructs the response with only `Content-Type`, dropping
`Retry-After` and reset headers from the original rejection. The client loses
the information it needs to back off correctly.

## Change

Restructure the native compact branch around a bounded local helper:

```ts
type CompactRecovery = "normal" | "single";
const sendCompactAttempt = async (
  authCtx: CodexAuthContext,
  recovery: CompactRecovery,
): Promise<Response> => { /* ... */ };
```

**The two recovery modes are the crux, not decoration.** Compact's current send
goes through `fetchWithTransientRetry()`
(`src/server/responses/compact.ts:275`), which makes up to three status
attempts, each wrapping its own reset retries (`src/lib/upstream-retry.ts:178`,
`:213`). So "exactly two sends" and "preserve A's existing recovery" contradict
each other unless the two accounts use different modes. An earlier draft said
"send B exactly once" without noticing the wrapper, and would have produced
either a B that retried up to nine times or an A that silently lost its reset
recovery.

The regular path already solved this and the fix copies it: A keeps
`fetchWithTransientRetry()` (`recovery: "normal"`), B goes through a single
direct `fetchWithHeaderTimeout()` (`recovery: "single"`), exactly as
`retryCodexPoolOnAlternateAccount()` does at
`src/server/responses/core.ts:396`. The asymmetry is deliberate there: A's
retries happen before any alternate is considered, and the alternate is a last
bounded try rather than a second retry ladder.

### The recorder has to change first

`recordCompactPoolOutcome()` (`src/server/responses/compact.ts:259-273`) closes
over a single `authCtx` and accepts only `{ retryAfter, resetAt }`. It cannot
express "record this against A, and promote B", and it cannot record an outcome
against B at all. So the two-account flow is impossible until the recorder
takes its context explicitly:

```ts
const recordCompactPoolOutcome = (
  ctx: CodexAuthContext,
  outcome: CodexUpstreamOutcome,
  meta: {
    retryAfter?: string | null;
    resetAt?: unknown | unknown[];
    promoteAccountId?: string;
  } = {},
) => { /* same body, ctx instead of the captured authCtx */ };
```

Every existing call site passes `authCtx` and is otherwise unchanged, so this
is a mechanical widening — but it is a prerequisite, not an implementation
detail, and an earlier draft of this doc assumed a signature that does not
exist.

Flow:

1. Send A with `recovery: "normal"` — unchanged from today, including transient
   and reset recovery.
2. On a pre-body 429/402 **only**, resolve
   `resolveCodexAuthContext(..., { excludeAccountId: A, modelId })`.
3. No alternate: do not cancel A. Buffer, **record A's outcome exactly as today**
   (`recordCompactPoolOutcome(authCtxA, upstream.status, { retryAfter, resetAt })`
   after buffering, per the current `:309-318` ordering, including the 499
   early return), and return A's status, body, status text, and sanitized
   headers unchanged. An earlier draft said only "buffer and return", which
   would have silently dropped health recording on the most common path —
   a regression disguised as a no-op.
4. Alternate B exists:
   - apply A's quota headers to its quota cache;
   - record A's actual rejection with retry/reset metadata, scope, writer
     generation, and `promoteAccountId: B`;
   - **build B's provider, headers, base URL, and auth context completely
     first**, then cancel A's body. If B's construction throws, A's body is
     still intact and its rejection can be returned to the client. Cancelling
     first would leave nothing to fall back to.
   - send B with `recovery: "single"` — one network send, no transient ladder,
     no reset retry.
5. Buffer B's response and record its outcome **against B's context**
   (`recordCompactPoolOutcome(authCtxB, ...)`), preserving the current
   record-after-buffer ordering and the 499 early return. No recursion, no
   reset-credit redemption.

**Attribution of a transport exception during B's send — preserve current
behavior.** Earlier drafts of this doc tried to define a neutrality rule here,
first attributing every B exception to B, then deferring to a transport-phase
classifier. Both are now moot: #914 and #919 left this unit entirely
(`devlog/_fin/260803_transport_attribution/`) after four rejected designs
established that no local rule correctly decides attribution.

So this phase does **not** change attribution semantics at all. A transport
exception during B's send records against B exactly as the current code records
against A — same helper, same outcome mapping. When
`260803_transport_attribution` settles the policy, it changes both call sites
together.

This also removes the ordering dependency the earlier plan carried. With the
transport-attribution work gone, this phase shares no contract with any other
phase in the unit; it is confined to the native compact branch in
`src/server/responses/compact.ts`.

MODIFY `bufferCompactResponse()` to preserve safe upstream headers, `Retry-After`
and reset headers in particular.

## Explicitly not in scope

The quota strategy deliberately rebinds an over-threshold thread at
`src/codex/routing.ts:1179-1200`, and tests cover that. The reporter's framing
suggests a 100% WHAM snapshot should never move an existing thread under any
strategy. That is a policy change with its own tradeoffs, not part of this fix.
Fill-first and round-robin already preserve ongoing affinity. Do not smuggle a
strategy change in under a compact-parity fix.

## Activation scenario

In `tests/responses-compaction-routing.test.ts`:

- A returns 429, B returns 200. Assert two sends, B's credentials on send two,
  A's body cancelled before send two, B's response returned. Repeat for 402.
- **No alternate available**: assert A's outcome is still recorded — same
  status, same retry/reset metadata — proving the recorder widening did not
  drop the common path. This is the regression the fourth-round audit caught in
  the plan rather than in the code.
- **B's construction fails** (resolve or provider build throws after A's 429):
  A's body is returned intact, not a 502. Proves the build-before-cancel
  ordering.
- **Outcome attribution**: A's rejection is recorded against A with
  `promoteAccountId: B`; B's final status is recorded against B. Assert the
  account ids explicitly — with a single captured context this test cannot
  pass, so it is the activation proof for the recorder change.
- **B returns a transient 5xx** (500/502/503/504/52x): assert B's `fetch`
  invocation count is exactly **one**. Under `recovery: "normal"` it would be
  three, so this assertion is what proves the mode is actually wired rather than
  defaulted — the activation proof for the whole two-mode design.
- **B's first socket resets**: again exactly one B `fetch` invocation. The reset
  ladder must not engage for the alternate.
- **A's transient recovery still works**: A returns 502 twice then 200, no
  alternate involved — assert A's normal retry behavior is intact. The control
  against "fixing" the cardinality by stripping A's recovery.
- No alternate available: exactly one send, and the returned rejection is
  equivalent to A's **over the sanitized allowlist**.
  `sanitizePassthroughHeaders()` (`src/server/relay.ts:1023`) deliberately drops
  content-length, content-encoding, cookies, and hop-by-hop headers, so
  byte-equality against the raw upstream response is the wrong assertion and
  would fail for reasons unrelated to this change. Assert: status, body bytes,
  `statusText`, and the presence and value of `Retry-After` plus reset headers.
- B also rejects: exactly two sends, B's rejection returned.
- Abort between attempts prevents B's send entirely.
- A cached at 100% under fill-first stays affined until A actually rejects —
  the guard against the scope creep named above.
- **B's send rejects (fetch throws)**: recorded against B and returned as 502,
  matching what the single-attempt path does today for A. Asserted so that a
  later attribution change has to update this test deliberately rather than
  silently.
- **B returns a real 5xx response**: B's outcome recorded, response returned.

The send-count assertion is the activation proof: one send means the branch
never fired, three means it recursed.

## Accept criteria

- The 429→alternate test fails with the helper reverted to a single send.
- Header preservation asserted on the no-alternate path (`Retry-After` present).
- Focused suite `responses-compaction-routing` green; full suite green.
