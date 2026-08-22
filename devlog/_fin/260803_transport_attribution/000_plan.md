# 000 — Transport failure attribution (#914, #919)

Split out of `260803_pr_issue_sweep` after successive designs were rejected at
the audit gate. The rejections are the useful content here: each one was
empirically grounded, and together they say the problem is not the shape of a
guard — it is that "should this failure count against the credential?" is a
policy question the codebase has already answered once, deliberately.

Both issues live here because they are the same question at two points on the
timeline: #914 is the failure before any response, #919 is the failure after
HTTP 200. Neither is a local bug fix.

## The defect

`src/server/responses/core.ts:1640-1656` maps every non-timeout `fetch`
rejection to `connect_error` and records it against the selected account;
`src/server/responses/compact.ts:275-301` does the same. Routing treats
`connect_error` as transient (`src/codex/routing.ts:297-307`), and at
`upstreamFailoverThreshold` it soft-avoids the account, clears thread affinity,
and promotes an alternate (`src/codex/routing.ts:1417-1465`).

The reporter's point stands: a DNS failure on the user's machine rotates them
off a working account, and the rotation cannot help.

## Three rejected designs

### 1. Match Node error codes on the rejection

`ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`, `ENETDOWN`, `EHOSTUNREACH`,
`ECONNREFUSED`. Dead on arrival: Bun 1.3.14's `fetch` does not emit them.

```text
fetch("https://no-such-host.invalid/x") -> code:"ConnectionRefused", errno:0, no cause
fetch("http://127.0.0.1:1/x")           -> code:"ConnectionRefused", errno:0, no cause
fetch("http://192.0.2.1:81/x")          -> TimeoutError after 4s
dns.lookup("no-such-host.invalid")      -> code:"ENOTFOUND"
```

A unit test injecting `code:"ENOTFOUND"` would have passed while the branch
never fired in production. Bun also gives DNS failure and connection refusal
the *same* label, so even a Bun-native code list cannot separate them.

### 2. Resolve the hostname to decide

On a rejection, run `dns.lookup()` (which does return Node codes under Bun,
including inside a live `Bun.serve` handler): lookup fails → neutral, lookup
succeeds → attributable.

Rejected for two reasons. Bun's labels are not a stable set — repeated fetches
to the same `.invalid` host alternate `ConnectionRefused` /
`FailedToOpenSocket` as Bun evicts its DNS cache, so every other request would
skip the probe entirely. And the inference is wrong: a hostname that resolves
can still refuse TCP behind a firewall, VPN, captive portal, or fake-IP proxy —
a configuration this repository explicitly supports
(`src/lib/destination-policy.ts:175`). TOCTOU runs both ways: a resolver that
recovers between fetch and probe gives a false attributable; one that flakes
gives a false neutral.

### 3. Use the boundary — "rejection means no headers arrived"

Skip health recording for every rejection, on the reasoning that a rejected
fetch means no server evaluated the credential, and that
`applyCodexAuthContextToProvider()` (`src/codex/auth-context.ts:310`) swaps the
token without changing the destination — so rotation cannot help by
construction.

The destination fact is true and verified. The boundary claim is not. Two
counterexamples reached the real wrapper:

- **Redirects.** Bun follows them by default, per the Fetch standard. A server
  received the authenticated request, returned `307` to `127.0.0.1:1`, and the
  wrapper ultimately rejected with `ConnectionRefused`. Headers arrived; the
  credential was seen; the rejection came after.
- **Read-then-close.** A raw server read `Authorization: Bearer credential-A`
  and closed the socket without responding. Bun rejected with `ECONNRESET`.

Both are credential-*visible* failures, and a credential-aware upstream can
behave differently for A than for B. So "rotation cannot possibly help" is not
structurally true, and a blanket guard can suppress a genuinely account-specific
failure.

## What the three rejections have in common

Every design tried to answer "was this the credential's fault?" from evidence
available at the catch. That evidence is insufficient in principle, not by
accident: Bun collapses distinguishable network conditions into one label, and
the request path can traverse an authenticating server before failing.

So the next attempt should not be a fourth classifier. Two directions worth
exploring, in this unit, with their own audit:

1. **Separate host health from account health.** The real content of #914 is
   that connection-level failures belong to a (provider, host) pair, not a
   credential — every pool account shares the host. A distinct health key with
   its own threshold would make the attribution question moot for the common
   case, and rotation would stop being the response to a network fault.
2. **`redirect: "manual"` plus an explicit 3xx policy**, which at least removes
   the redirect counterexample and makes the remaining surface small enough to
   reason about. It does not solve read-then-close on its own.

Whichever is chosen, the accept criteria must include the redirect-chain and
credential-dependent socket-close activation cases the third design lacked, and
the residual false-negative class must be documented rather than argued away.

## Status

Not started. #914 and #919 stay **open** with comments recording this analysis.
Neither is fixed by `260803_pr_issue_sweep`, and claiming otherwise would be
the exact overreach the audit rounds prevented.

## #919 — the post-200 half, and why it is not a quick fix either

#919 spent one round in the sweep unit as "the easy one": the synthetic/real
distinction is already carried on `RequestLogContext`
(`src/server/request-log.ts:97`), so the fix looked like reading a field rather
than inferring anything. The reviewer rejected that framing by finding the
decision record for the code in question.

`consumeForInspection()` reports a synthetic `failed, 502` when the upstream
body read rejects after HTTP 200 (`src/server/relay.ts:988`,
`src/server/relay-eager.ts:256`). That was not an accident of implementation.
`devlog/_fin/260722_issue_bug_sweep/030_patch_s_sticky_502.md:85` introduced it
with this comment, still in the source today:

```ts
// Upstream read failure after HTTP 200 (mid-stream socket reset). This is
// NOT the protocol `response.incomplete` terminal — report `failed` with a
// synthetic 502 so the account-health recorder treats it as a transient
// upstream failure instead of a success.
```

And its test matrix (`:162`) records the intended outcome explicitly:
`upstream read rejection (200 후 socket reset)` → `transient 실패 기록,
affinity 해제`. The behavior #919 reports as a defect is the behavior that
patch was written to produce.

So the sweep unit's framing — "a synthetic 502 the proxy invented is not
upstream's verdict on the credential, and fixing it needs no inference" — was
wrong on both halves. `terminalSource="synthetic"` proves the proxy
manufactured the *event*; it says nothing about whether the underlying reset
was account-neutral. Both relay implementations classify it as an upstream read
failure, which is what it is.

### What the real question is

A received HTTP 200 does prove the credential authenticated. But account health
does not track only credential validity — it tracks transient reliability,
which is why ordinary 5xx responses count. An upstream that accepts the request
and then drops the socket mid-stream is exhibiting exactly that kind of
unreliability.

So #919 asks for a policy change: **should post-200 transport reliability
affect account routing at all?** Arguments exist both ways.

- For the reporter: every pool account shares the host, so rotating away from
  account A does not repair a host that drops connections. The rotation costs
  thread affinity and buys nothing.
- For the current behavior: if the drops correlate with one account — a
  per-account rate limiter that cuts the stream rather than returning 429, say
  — then rotation is precisely the right response, and the 2026-07-22 patch was
  written because something real motivated it.

Settling that needs evidence about whether mid-stream drops correlate with
accounts in practice, not a preference. Which is the same shape as #914's
resolution: separate host health from account health, and the question stops
being a coin flip.

### Constraints for whoever takes this

- Do not silently revert the 2026-07-22 decision. If it is reversed, say so and
  say why, in the same place it was recorded.
- Any activation scenario must drive **both** relay paths — `legacy-tee`
  (`src/server/relay.ts`) and `eager-relay` (`src/server/relay-eager.ts`) set
  these fields separately, so a test through one proves nothing about the
  other.
- Client cancellation must keep recording nothing. That guard is load-bearing
  and already tested.

## One more rejected-design lesson, from Round 3

Recorded here because a future implementer will otherwise rediscover it: the
outer catch does not see the whole attempt history.

`fetchWithTransientRetry` (`src/lib/upstream-retry.ts:213-238`) returns a
transient 5xx only when it is the *final* attempt's result. When attempt one
returns 503, the helper cancels that body and retries; if a later attempt
rejects, the outer catch sees only the rejection. A genuine, attributable
upstream response arrived and left no trace at the point where the decision
gets made.

Verified by runtime probe: `503 Response → retry rejection` ends as a rejected
`fetchWithTransientRetry`. Any future design that keys on "the promise
rejected" inherits this hole, and any acceptance criteria must include the
mixed `5xx → rejection` case on the regular path, the compact path, and the
alternate-account send.
