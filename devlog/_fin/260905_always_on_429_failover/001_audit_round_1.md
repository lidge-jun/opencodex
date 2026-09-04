# 001 — Audit round 1 (grok-4.6, read-only plan audit)

Verdict: **fail**, four blockers. All four independently reconfirmed against source before
amendment; none were rebutted.

## B1 — Two rotation surfaces were missed entirely

The plan's call-site inventory was incomplete, and both omissions violate the binding
requirement on their own.

**B1a. The continuation loop has no generic-OAuth arm.** `src/server/responses/core.ts`
~6549-6628 rotates API keys (`hasKeyPoolFailover` + `rotateProviderTransportOn429`) and
Anthropic (`rotateAnthropicAccountOn429`) — and nothing else. Confirmed by scanning the
window: the only rotators present are those two. So an xAI or Cursor continuation 429 never
moves to a second account *even today, with failover fully enabled*. This is a pre-existing
defect in #2568's coverage, not something this unit introduces, but it sits exactly inside
the user's requirement.

**B1b. The sidecar hook has no Anthropic arm.** `rotateSidecarProviderOn429` (~5201-5245),
injected into both the web-search and image-bridge loops, tries the key pool and then
*generic* OAuth. Anthropic is excluded from generic failover by design, and the hook never
reads `anthropicPoolAccountId`. Confirmed: no occurrence of `anthropic` in the hook body.
So an Anthropic 429 inside a web-search or image turn does not rotate — with the pool ON
either. Also pre-existing, also in scope.

## B2 — Three existing tests assert the behaviour this unit reverses

Doc 020 claimed existing tests keep passing. False:

- `tests/generic-oauth-failover.test.ts:80` — "an explicit knob still wins over presence"
  expects `rotateGenericOAuthAccountOn429(config(false), ...)` to be `null`.
- `tests/generic-oauth-failover.test.ts:107-114` — "a per-provider override beats the global
  switch" expects `isGenericOAuthFailoverEnabled(config(true, false), "xai") === false`.
- `tests/adapter-event-oauth-failover.test.ts:129` — "an explicit opt-out keeps single-account
  behaviour with two accounts stored" asserts the 429 is relayed on `config(false)`.

These are not incidental: they are the encoded intent of #2568d, which the user is now
explicitly overriding. They must be **rewritten to assert the new contract**, with the reason
recorded in the test body, not deleted and not left to fail. `tests/adapter-event-oauth-failover.test.ts`
joins the focused verification list in 030.

## B3 — 010 Change 2 proposed a duplicate credential resolution

Rejected in favour of the note that followed it in the same doc. Anthropic *does* reach the
shared else-arm when the pool is off (the inner `if` requires the pool flag), `resolved.accountId`
there is the account that actually served the request, and a second
`getValidAccessTokenSnapshot("anthropic")` would mint a redundant credential read. Capture is
one line beside the existing `genericFailoverAccountId` stamp.

## B4 — 030's "the GUI does not lie" claim is false

`gui/src/i18n/en.ts:1818`: `"anthropicPool.disabledDesc": "Uses only the active Claude account."`
After this change, disabled still means no affinity and no proactive pick — but a 429 *does*
move. That string becomes stale. `gui/` stays out of scope (the AGENTS.md screenshot gate is a
real cost for a routing fix), so 030 must record it as **known-stale copy with a follow-up**,
not as truth-preserving.

## Round 2

Re-audited by the same reviewer after the amendments above. B1a, B2, B3 and B4 confirmed
closed. B1b's *reasoning* was confirmed sound but its *code* was not implementable: the
proposed `else if` sat behind an early `return null` and would have been dead code, with a
naive string test still passing. Fixed in 040b by inverting the generic gate into a positive
`else if` and deferring `return null` to a trailing `else`. Round 2 also confirmed both
occurrence-count guards (`failoverAccountSnapshot(` and `applyFailoverSnapshot(snapshot)`)
must move 3 -> 4, and that `oauth-account-429` is already a valid `AttemptRecoveryKind`
(`src/usage/log.ts:52`).

## Accepted without change

Audit items 3 and 6 confirmed the plan: dropping the loop flag-clause introduces no regression
(the all-cooled synthetic 429 at ~3399 correctly stays proactive-gated), and the credential
pairing rules hold — Anthropic has no per-account origin or project, so its token-only swap is
safe, and `applyFailoverSnapshot` must not start being used for it.
