# 020 — wp3: a transient streak is a detour, not an eviction

## Today

`recordCodexUpstreamOutcome` handles a transient (non-429/402) failure by counting
consecutive failures and, once `upstreamFailoverThreshold` (default 3) trips,
doing three things: it writes an escalating `softAvoidUntil`, it deletes **this**
thread's pin with `deleteThreadAffinitiesForAccount`, and then it clears **every**
thread pinned to that account with `clearThreadAccountMapForAccount`
(`src/codex/routing.ts:3009-3016`).

The resolve path enforces the same conclusion independently: `failoverReady` is one
of the gates that fails the reuse branch, so the next continue deletes the binding
at `:2522` even if the recorder had left it alone. The preview path carries the
same gates at `:2176-2189`. Fixing only the recorder would be a no-op.

This is the hole that survives `pool.cacheAffinity`. The flag governs the quota
preference and nothing else, so three 503s — a provider-wide overload that has
nothing to do with this account — discard the binding and the warmed prefix
exactly as an 80% threshold crossing used to. #4269 already showed how badly this
misfires: a retryable 503 whose human-readable message happened to contain
"reauthentication" was classified as an auth error. A failure's blast radius must
come from its scope, not from its text or its count.

## The rule

Being temporarily unable to send is not the same as giving up ownership of the
conversation. Separate the two:

| Account state | This request | The binding |
| --- | --- | --- |
| Healthy | served by the bound account | held |
| Transient streak / soft-avoid | served by an alternate | **held** |
| Hard cooldown from quota refusal (429/402) | served by an alternate | released |
| Unusable, paused, credential-invalid, generation-stale | released | released |
| Known 100% usage | served by an alternate | released |

The middle row is the change. The request detours; the thread keeps its home.
When the streak clears — and the existing `preservedCooldownFields` design means
`lastFailureStatus` survives exactly until the account serves again — the thread is
served by its own warm account with no further action.

## The bound on the hold

A hold with no expiry is a different bug: an account that never recovers would keep
a thread detouring forever while the real conversational cache accumulates
somewhere else. The hold is therefore bounded. The affinity entry records when the
detour started; if the bound account is still unusable when that window lapses, the
binding is released normally and the thread rebinds through the ordinary path. A
successful serve clears the marker.

This keeps the failure modes ordered correctly: a blip costs nothing, a sustained
outage converges to a real rebind, and neither one is decided by a message string.

## Where it changes

- `recordCodexUpstreamOutcome` transient branch — the two affinity clears become
  conditional on the release policy rather than unconditional on the streak.
- `resolveCodexAccountForThreadDetailed` — a reuse that fails **only** on
  transient evidence takes the detour branch instead of the delete branch.
- `previewReusableAffinityAccount` — same classification, so preview keeps agreeing
  with resolve.

The existing race guard stays exactly as it is: a late failure arriving from
account A must never disturb a binding that has already moved to B, which is what
the generation check and the pinned-account guard in
`deleteThreadAffinitiesForAccount` exist for. Nothing here relaxes them.

## Regression tests

1. Three transient 5xx failures on the bound account: the next resolve returns a
   different account **and** the binding still names the original.
2. The account then serves successfully: the following resolve returns the original
   account again.
3. The streak persists past the hold window: the binding is released and the thread
   rebinds to the account that can serve.
4. A 429 on the bound account still releases the binding immediately, unchanged.
5. A late transient failure from an account the thread already left does not touch
   the current binding.

## R07 outcome: expiry is permission to re-decide, not a recovery

The rule above bounded the hold correctly and then threw away its own evidence. On expiry the
entry was deleted whole -- `transientDetourAccountId` with it -- and the thread re-picked cold,
so an account that had been serving the conversation happily for ten minutes got no more
consideration than any other. A timer running out restores the right to re-decide; it is not
itself a reason to prefer a stranger.

A still-healthy detour is now promoted to the binding, recorded as `rebound` with reason
`transient_hold_expired`. Promotion is refused when the release reason is generation
invalidation or a quota refusal: those are hard invalidations, and a detour that merely looks
healthy must not rescue them.

What this still does not do: a soft-avoided account receives no traffic at all, so the
two-consecutive-success clearing rule can only be met through the "held" fallback, which hands
the failing account back to every pinned thread at once. A half-open probe lease -- one thread
probes, the rest keep detouring -- is the missing piece and needs a lease keyed on the health
domain rather than the quota cooldown domain the existing one uses.
