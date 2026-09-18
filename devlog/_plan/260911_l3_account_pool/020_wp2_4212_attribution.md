# WP2 — #4212 a pool account stuck on a failed credential refresh drops its models without naming itself

## Scope, and why this is `Refs` rather than `Closes`

The reporter saw two things: gated models vanished from the model list, and requests failed with a
generic 503. Neither publisher is L3's.

- The 503 they quoted is inlined at `src/server/responses/core.ts:2336` and `compact.ts:383`. L1 owns
  both. Recorded as a follow-up.
- The model-list drop is published from `src/codex/catalog/sync.ts:1777`. Out of scope. Recorded as a
  follow-up.

What L3 owns is the layer underneath: the decision that removes the account, and the surfaces that
describe it. Packet decision, followed as written.

## The actual defect

The issue names it precisely: `isAccountNeedsReauth(accountId)` makes the account unselectable
"with no reason carried to callers". `isCodexAccountUsable()` returned a bare boolean, so every
surface that wanted to explain a refusal had to re-derive the cause from a different source. That is
how a surface ends up reporting an account healthy while routing is dropping it.

So the reason now comes from the same function as the decision. `codexAccountUnusableReason()` holds
every branch and returns the cause; `isCodexAccountUsable()` is its boolean projection rather than a
second copy. A reason cannot name a cause routing did not use, and routing cannot refuse an account
for a cause no surface can name.

That refactor is the risky part of this change — `isCodexAccountUsable` is called from routing,
auth-context, sidecar auth, and subagent fallback — so it was audited for exact equivalence rather
than reviewed by eye. See below.

## Attribution on the account surface

`poolAccountDto` computed `needsReauth` as an OR of three independent causes plus a persisted
verdict resolved inside the health projection, and emitted only the boolean. It now also emits
`reauthReason`: `missing_credential` for a credential that was never stored, `refresh_failed` for a
refresh that keeps failing — the reporter's case — and `quota_unauthorized` when the usage lookup
itself was rejected. `/api/oauth/accounts` already carried that field name, so the Codex account
surface now matches its sibling. The main row carries it too, so the field's contract holds for
every row rather than only pool rows.

## The refusal string

`nativeMainRefreshFailureResponse` said "retry this request" and nothing else, which is how the
reporter concluded the proxy had broken. It stays a retryable 503 with `Retry-After`, because the
refresh genuinely may succeed, and now adds that a failure which persists means the main account
needs reauthentication.

The pool-account 401 was deliberately left alone. `tests/server/server-search.test.ts:344` asserts
that message must not contain the account id, alias, or email — naming the account there is a
privacy decision this repository already made against, and it is not L3's to reverse.

## Audit

Three read-only `xai/grok-4.6` subagents, in parallel.

- **Equivalence (pass).** No input changes the truth value, helper call count, call order, or throw
  set. `readCodexAccountRecord` is still called exactly once and only after the existence and reauth
  checks; the `isMainAccountTokenLive` seam still fires 0 or 1 times, not 2; the expanded pool tail
  is truth-equivalent for a null record, a record without a credential, `deletedAt` set, and
  `codexValidationPending`.
- **DTO and error layer (pass, 5 non-blocking findings).** Three were folded in: the main row now
  carries `reauthReason`, the union comment no longer overclaims what the current health projection
  can produce, and the DTO-layer assertion was added to the existing refresh test. Two were recorded
  rather than fixed: the request-path 401 (privacy, above) and the GUI not yet reading the field.
- **Re-audit after fold-in (pass).** Confirmed the main-row `||` still short-circuits so the
  stale-generation cleanup call count is unchanged, that the main row cannot emit a reason without
  the boolean or the reverse, and that all eight locale inserts are localized and correctly placed.

## Verification

Local suite, typecheck, and build: NOT RUN by operator instruction. Hosted CI on the pushed head is
the evidence.
