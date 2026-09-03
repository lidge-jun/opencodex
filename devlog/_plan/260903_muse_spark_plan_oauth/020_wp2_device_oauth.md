# wp2 — Muse Code plan credential: CLOSED as a recorded negative

> **Superseded by wp4 (`003`, `040`).** This close was correct on the evidence available
> and its reasoning is not retracted: proving a credential works is not the same as being
> allowed to use it. What changed is who decides. The repository owner completed the login
> and payment on his own account and asked for this to ship behind a warning — a user
> spending his own ToS risk, not an agent spending it for him. Read this doc as the
> record of why an agent would not have shipped it unprompted.

**Outcome at the time: `NOOP`. No code shipped from this phase.**

This phase existed to answer whether a Muse Code subscription can drive opencodex. It
can be answered without building anything, and the answer is no.

## What was measured

A real `muse login` was run twice on this machine (Muse Code 1.0.2, installed from
`https://dev.meta.ai/install.sh`). Both reached:

```
Open this page to sign in:
  https://auth.meta.com/oauth/device/?code=<expired-code>
Waiting for approval…
```

Neither was approved. Both processes were terminated, and a targeted check for a Muse
credential found none on this machine.

That observation is **device-code-shaped**, and the round-2 audit was right to stop me
calling it RFC 8628. A URL carrying a user code proves a browser-approval login exists.
It does not establish the token endpoint, scopes, rotation, or expiry semantics, and it
certainly does not establish that another client may hold the result. `002` records the
observation with that narrower framing.

## Why this closes rather than waits

The first revision of this doc planned to measure whether the stored credential
authenticates `https://api.meta.ai/v1`, and to ship an OAuth provider if it did. The
round-2 reviewer named the flaw in one line, and it is correct:

> Endpoint acceptance does not override the quoted restriction that the credential is
> "for use with Muse Code only." A warning records informed risk; it does not create
> vendor authorization.

That test was designed to discover whether enforcement was **absent** — not whether use
was **permitted**. Those are different questions, and only the second one licenses
shipping. Meta has answered the second one already (`001` §E):

> This credential is for use with Muse Code only. Any additional API keys you create
> under your Meta Model API account will be billed through pay-as-you-go.

A user warning does not convert a prohibited use into an allowed one; it only documents
that we knew. The goal's own wording is "**legitimately** drive a local proxy", and an
unenforced restriction is still a restriction.

So the credential is not extracted, not replayed, and not tested against the API. That
is a deliberate stop, not an incomplete measurement.

## The third-party report

A Threads user (2026-09-03) reported that pay-as-you-go bills by default under the plan,
that the Muse-scoped key sits in the macOS Keychain in plaintext, and that "the endpoint
is not separated" — i.e. the CLI credential works against the general API.

Two of those are unverified, and the third does not change the outcome even if true.
"The endpoints are not separated" is exactly the enforcement-absence observation above.
If anything it makes the recorded negative more valuable: the only thing standing
between a user and an accidental ToS breach is knowing the boundary exists.

The billing half **is** actionable, and it is why wp1's provider note states plainly
that a Muse Code subscription does not apply and every call is metered per token.

## Reopen conditions

Reopen only on a first-party change. **Not** on a discovery that enforcement is loose —
that distinction is the entire finding:

1. Meta documents the device flow for third-party clients.
2. `/docs/muse-code/subscriptions` drops the "for use with Muse Code only" scoping.
3. Meta ships a documented plan-backed API tier, as Anthropic and Kimi did.
4. Meta explicitly authorizes third-party clients on a subscription credential.

Recheck cost is one docs read.

## If it is ever reopened

The plan would need what this doc deliberately does not contain: exact token endpoint
and client id, request/response types, identity/expiry/refresh semantics, an error
taxonomy, cancellation behavior, the chosen `src/oauth/<id>.ts` filename and registry
id, and — the seam the round-2 audit caught — a `gui/src/oauth-tos-risk.ts` entry with
its `tests/oauth-tos-warning.test.ts` coverage, since that is the login-time warning
gate a provider note bypasses. Writing those against an unproven protocol would be
fabrication, so they are not written.

## What did ship from this phase

The disclosure in wp1's provider note, which is the user-visible half of this finding
and the part that prevents a surprise bill.
