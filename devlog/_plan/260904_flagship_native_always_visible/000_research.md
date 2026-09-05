# 260904 — Flagship natives are always visible

## Decision

`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` and `gpt-6-astra` list unconditionally. Every
other native keeps deriving visibility from the live catalog and the authenticated roster.
`gpt-daybreak-blue-latest` stays account-gated.

Owner decision, 2026-09-04. This is the second half of the work begun in #3442: that PR stopped
a stale client version from making discovery ask a question whose answer omits gpt-5.6. This one
removes the roster from the visibility question entirely for the flagship set.

## Why the version fix was not enough

#3442 guarantees we ask upstream under an adequate version. It cannot guarantee an answer. A
roster still fails to confirm when the account is unconfirmed, the fetch times out, the network
is down, or the account genuinely does not carry the slug on its shard yet. In every one of those
cases the model silently disappears from the picker, which reads to the user as "opencodex lost
my model" rather than "upstream did not confirm it".

Live evidence from this session: two subagent dispatches against `gpt-5.6-sol` died with
`401 No eligible Codex account supports this model` from the local proxy. That string is
`src/codex/auth-context.ts` refusing before dispatch, on entitlement evidence alone.

## Mechanism

`ACCOUNT_GATED_NATIVE_OPENAI_MODELS` in `src/codex/catalog/native-models.ts` is the single
switch. Membership makes `nativeModelRows` and `nativeOpenAiSlugs` filter the slug out unless
`availableAccountGatedNativeModels` confirms it, and makes `auth-context.ts` refuse the request
before it is sent.

`gpt-6-astra` was already ungated by exactly this route in `6f634eddc`, and the 5.6 trio is
already listed in `DOCUMENTED_NATIVE_OPENAI_ADDITIONS`, so the change is removing three strings
from one set. Following the existing precedent rather than inventing a mechanism is the point.

## The four risks, settled

**1. Authorization.** The set is the only trigger for the entitlement checks in
`auth-context.ts` (~408, ~435, ~461, ~498) and `isDirectCallerEntitledToCodexModel` returns
`true` immediately for any slug outside it. What disappears is a pre-flight roster check. What
remains: a caller-owned Direct request still dispatches on its own bearer; the admission-bearer
path still runs the drain fence, `beginCodexAccountSelection` and `claimMainProfile` before the
gated check, and its account is fixed as main by construction. No path can select a wrong
account or send one account's credential under another. Unentitled means an upstream 400, which
is the honest answer and the same posture astra ships.

**2. Wire normalization.** `CODEX_ACCOUNT_GATED_CANONICAL_WIRE_MODELS` holds exactly one entry,
`gpt-daybreak-blue-latest -> gpt-5.6-sol`. The trio are the *target* of that rewrite, never a
key, and the function reads its own map rather than the gated set. The wire id for the trio is
the slug itself, before and after. No edit needed.

**3. The floor — the one that could have undone #3442.** `deriveGatedClientVersionFloor` filters
the bundled snapshot to slugs *in the gated set*. All three carry `minimal_client_version`
`0.142.2`; Daybreak has no row. So after removal the derivation returns `null` and falls to the
`0.142.2` fallback. Measured directly against the real snapshot:

```text
derived NOW    = 0.142.2      derived AFTER  = null
composed NOW   = 0.144.0      composed AFTER = 0.144.0
```

The floor holds, because `MEASURED_GATED_CLIENT_VERSION_MINIMUM` wins the comparison either way.
But it is now held up by that constant *alone*, with the derivation permanently inert — the
opposite of what its comment anticipates ("when a future snapshot refresh records 0.144.0 or
higher, the derivation takes over naturally"). That comment must be corrected.

**`ACCOUNT_GATED_NATIVE_MODEL_MINIMUM_CLIENT_VERSIONS` keeps all three entries.**
`hasUnknownGatedAbsence` iterates that map on its own, never consulting the gated set, to choose
between the 5-minute success TTL and the 15-second failure TTL. After #3442 every version-less
resolution is clamped to the floor, which equals the minimum these entries hold, so the guard is
reachable only through tier 1 — a client that self-declares an older version. The entries keep
that under-versioned escape hatch alive, which is the whole of why they stay.

The cost, recorded rather than hidden: such a client drops the entire account roster to the 15s
failure TTL instead of 5 minutes, a 20x refetch amplification bounded to four concurrent flights
per account, and after ungating that buys nothing for the trio. Small, bounded, and only
reachable from a self-declared old client. (An earlier draft justified these entries by claiming
they protect Daybreak; that was false — Daybreak is deliberately absent from the map. See
`005_audit_synthesis.md`.)

**4. Pool routing — a real trade, recorded rather than discovered later.** `modelEligibleAccountIds`
becomes `undefined` for the trio, so `pickCodexAccount` stops filtering candidates by grant. In a
multi-account pool where only one account owns sol, a request may now land on a non-owning
account, take a 400, and spend one blind alternate retry, where today it was routed to the owner.
Nothing unsafe: selection binds each account's own credential and `retryCodexPoolOnAlternateAccount`
refuses alternates for a fixed account. The bounded same-account 400 replay also collapses from
seven retries to one, since that ladder is gated on the same set.

This is the honest cost of the decision. It is accepted because the failure it replaces is worse
*for the user this change exists to serve*: an owner whose roster did not confirm in time sees
the model vanish, with no error and no way to tell whether they own it. For them a visible
refusal beats a silent disappearance.

The claim does not generalise, and the audit was right to push on it. `gpt-5.6-luna` is not just
a picker row: it is the default web-search sidecar model (`src/web-search/index.ts`) and the
shadow-call source model (`src/lib/shadow-call.ts`). A single-account user who does not own it
can now select it as a default and get recurring upstream errors where the row used to be
absent. That is the real trade, and it is the owner's call to accept it.

## Two more readers of the gated set

`subagentFallbackNeedsModelEntitlements` returns false for a trio-only fallback chain, so the
dispatch skips entitlement resolution entirely and `modelEligibleAccountIds` is undefined for the
whole request. And the `accountGatedModel` affinity diagnostic reclassifies the trio — telemetry
only, but the recorded semantics change.

`subagent-model-fallback.ts` also gates `preserveDrainingMainCandidate` on the set. That one is a
genuine hazard rather than an accepted cost: ungating it would let a native-main drain silently
rewrite the operator's configured subagent model instead of returning maintenance. The predicate
moves to the native OpenAI set, which is what it always meant — the drain fence protects the
atomic main claim and has nothing to do with entitlement. See `005_audit_synthesis.md`.

## Account-qualified clones

`codex-<account>/gpt-5.6-sol` will now be emitted for every configured selector, including
accounts that do not own the model, because the caller-side filter in `convergence.ts`,
`sync.ts` and `index.ts` short-circuits on `!ACCOUNT_GATED...has(slug)`. Accepted: astra already
behaves this way, and a bare row that always lists while the account-qualified row stays hidden
would be incoherent — the qualified row is the more specific selector, and it is exactly what a
multi-account user needs in order to discover which account owns the model.

One user-visible consequence: an unentitled exact selector used to throw
"Selected Codex account does not support this model" and will now surface an upstream 400.

## Work phases

- `010` — ungate the trio, keep the minimums, correct the comments, retarget coverage.
- `020` — land it.
