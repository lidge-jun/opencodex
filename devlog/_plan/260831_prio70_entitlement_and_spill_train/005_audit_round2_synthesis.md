# 005 — audit round 2: FAIL again, and the collapse it forced

Same reviewer, re-verification round on the amended plan
(`22e5eebed` -> `9020c0723`). Two of four blockers closed; two stayed open and one
new defect appeared. All re-verified in-tree before acceptance.

The honest reading: round 1 fixed the *descriptions* but wp1 2b and wp3's fallback
were still unimplementable as written. This round collapses both to something that
can actually be built.

## CLOSED — blocker 2 (logged-out enumeration)

The bounded negative memo closes the loop. One correction accepted: credential
commits do not invalidate entitlement state today
(`src/codex/account-store.ts:131`, `src/codex/auth-api.ts:2015`,
`src/codex/model-entitlements.ts:630`), so a fresh login stays invisible for up to
the memo TTL. Amendment: pin the TTL explicitly and clear the memo on known
credential writes. Added to `020`.

## CLOSED — blocker 4 (diagnostic transport)

`/api/providers` returns provider objects already carrying `discovery`
(`src/server/management/provider-routes.ts:455`), so an additive sibling is a real
compatible transport.

## STILL OPEN — blocker 1: "unknown" has nowhere to live

This is the finding that matters, and it kills 2b as drafted.

Two facts, both verified:

1. `CachedAccountModels` records `clientVersion` (`:230`) but
   `resolveCodexModelEntitlements` **discards it** when building
   `CodexModelEntitlementSnapshot` (`:236`, `:547-550`). The projections literally
   cannot see which version answered.
2. The projections are **positive-only**. `entitledCodexAccountIdsForModel` and
   `availableAccountGatedNativeModels` compute "which accounts/models are
   granted" (`:570`, `:573`). Adding a third boolean term to a positive-only
   filter can only do one of two things: narrow it further (redundant — absence
   already yields nothing), or *widen* it to include a model upstream never
   granted. The second is exactly the fail-closed violation `010` promised not to
   commit.

So "treat absence as unknown rather than denied" has no representation in the
current contract. There is no third state to move a model into; there is only
*granted* and *not present in the output*.

Third fact, and it makes the draft's own test wrong: **`gpt-5.5` is not
account-gated.** `ACCOUNT_GATED_NATIVE_OPENAI_MODELS` is exactly
`{gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-daybreak-blue-latest}`
(`src/codex/catalog/native-models.ts:5-10`); `gpt-5.5` is in the ungated native
list at `:70`. Test 4 asserted that `gpt-5.5` survives — but `gpt-5.5` was never
at risk, because `confirmed` only gates the gated set. The test would pass
vacuously and prove nothing about over-denial.

### Collapse: drop 2b from wp1

2b was a safety net for a *future* upstream floor bump, not the repair for #3022.
Change 1 already fixes the reported defect by asking under `0.144.0`. A tri-state
entitlement contract — snapshot field for the answering version, an explicit
per-model minimum map, and projections that admit only `granted` while carrying
`unknown` separately — is a real subsystem change with its own blast radius across
three exported functions and every caller.

**Decision: wp1 ships Change 1 + Change 2a only.** 2a is well-formed and
account-scoped: an empty parsed roster stops being a confirmation. The tri-state
work becomes `wp5` (`050`), sequenced after the train's user-visible fixes, where
it can be designed rather than smuggled in.

This is a scope reduction, not a scope *retreat*: #3022's reported symptom is fully
addressed by Change 1, and 2a removes the five-minute lockout that made recovery
slow. What is deferred is hardening against a hypothetical future bump.

## STILL OPEN — blocker 3: the fallback outruns its own cap

Round 1 added a wall-clock cap to the drain, then specified a synchronous
publication as the cap-expiry fallback. The reviewer caught that the fallback is
not inside the cap:

- the synchronous writer hardens the directory and the temp as **separate** calls
  (`src/responses/spill-store.ts:324`);
- each hardening call resolves its **own** 30s budget
  (`src/lib/windows-secret-acl.ts:799`, `HARDEN_DEADLINE_DEFAULT_MS = 30_000` at
  `:255`), with the documented timeout-path worst case ~90s at load and ~60.25s on
  the owner path.

So entering the fallback *after* the cap expired can block for another minute or
more. A 5-second cap followed by a 60-second fallback is not a bound.

### Amendment: the fallback must share one deadline, and the async writer must be disowned

wp3 now requires:

1. A single end-to-end shutdown budget covering drain **and** fallback.
2. The fallback passes its remaining budget down rather than letting each harden
   call open a fresh 30s window. `OPENCODEX_ACL_TIMEOUT_MS` shows the deadline is
   already parameterizable; the plumbing is the work.
3. Explicit ownership transfer: when the drain gives up on a job, the async writer
   must be marked superseded so a late completion cannot publish over the
   fallback's result. A late writer winning the race is the same lost-continuation
   bug wearing a different hat.
4. New regressions the round-1 list omitted entirely: cap expiry enters the
   fallback; the fallback respects the *remaining* budget; a late async completion
   after cap expiry does not overwrite.

**Accepted from the reviewer:** a synchronous stall is acceptable *at shutdown
specifically*, because that is the only path that reaches `flushResponseState()`
and no request is being served. #3011 is about the request path. But it is only
acceptable with an enforceable end-to-end deadline — otherwise wp3 trades a
startup stall for a shutdown hang.

If that plumbing turns out to be larger than the drain itself, split it: land the
drain with a cap that simply *abandons* (accepting the documented loss for the
>2 MiB case, unchanged from today's behaviour) and file the bounded-fallback work
separately. Abandoning is not worse than the status quo; hanging is.

## NEW DEFECT — wp4 specified an unreachable state

`040` listed "confirmed roster that is genuinely empty" as a diagnostic state,
while `010` Change 2a makes every empty parsed roster **unconfirmed**. The state
cannot occur.

The deeper point: without a completeness marker in the roster contract, the system
genuinely cannot distinguish "this account owns nothing" from "upstream returned an
unusable empty answer". Inventing a diagnostic label for a distinction the data
does not support would be a lie in a status field — the exact failure `002` blamed
`discovery: ok` for.

Amendment: `040` drops that state and replaces it with `unconfirmed-empty`,
described honestly as "upstream returned no usable rows; we cannot tell whether
that means no entitlement". Recorded in `001`'s open questions as the underlying
contract gap.

## Non-blocking correction carried

`010` still repeated the disproven `372000` -> `NATIVE_GPT56_CONTEXT_WINDOW` claim
that `004` had already corrected. Fixed in this round: the constant is
independently `272_000` and overrides the snapshot
(`src/codex/catalog/metadata.ts:130`, `:155-157`).
