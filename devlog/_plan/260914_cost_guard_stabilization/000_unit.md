# 260914 — Cost-guard stabilization for pooled Codex routing (#4546)

## Where this starts

#4546 reports that account-pool routing moved a **live** conversation between
accounts once the pool got hot, discarding the account-isolated prompt-cache
prefix on every hop. The reporter measured roughly 1.9 billion total tokens and
323 million uncached tokens across 15,607 requests in about thirteen hours on
five accounts, with a 7k-token turn arriving upstream as a 150k-token turn.

Those are two different numbers and this unit keeps them apart. Total tokens,
uncached throughput, billed API cost, and subscription quota drawdown are four
separate quantities; only the second is directly attributable to a routing
decision, and the Pro-plan quota-to-dollar conversion is not verifiable from the
report. The defect is real regardless: uncached throughput is the thing routing
controls, and routing multiplied it.

## The shape of the defect

The single-threshold rule is the visible half. `autoSwitchThreshold` (default 80)
answers two unrelated questions with one number: *should a new session be placed
here* and *should an existing session be evicted from here*. Those have opposite
cost structures. Placing a new session on a cooler account costs nothing, because
there is no warm prefix yet. Evicting a live session throws away a prefix that was
paid for once and would otherwise be reused for the rest of the conversation.

The invisible half is that nothing put a floor under the destination. The bound
thread moved to whichever eligible account was **strictly cooler** — by any margin.
Once every account sits in the 80–99% band the coolest one is still over the
threshold, so the next turn moves again. Because the same predicate also
short-circuits the 60-second re-score interval, a thread in that band is
re-scored on *every request* rather than once a minute. That is the ping-pong.

`pool.cacheAffinity` (#4292, merged 2026-09-12) already raises the eviction bar to
genuine exhaustion, but it is opt-in and off by default, so no existing install is
protected by it. And turning it on does not close the hole: a transient failure
streak deletes the binding through a different code path that never consults the
flag.

## Objective

Make the reported incident structurally impossible rather than less likely, in
priority order, with each work phase independently revertible.

The governing policy, stated once:

> **A live binding is held for cache; a new session is placed for capacity; a
> failure is handled at the scope where it actually occurred; and expensive work
> is bounded before it is sent, not after it is billed.**

## Roadmap

| Doc | Work phase | Outcome |
| --- | --- | --- |
| `010_bound_binding_policy.md` | wp2 | Cache-first is the default for bound threads, and a move requires a destination with real headroom |
| `020_backoff_preserves_binding.md` | wp3 | A transient streak routes around an account without surrendering ownership of the thread |
| `030_move_reason_evidence.md` | wp3 | Every live-binding move carries a machine-readable reason |
| `040_send_budget.md` | wp4 | One logical request has one total send budget across every retry layer |
| `050_worker_isolation.md` | wp5 | Fan-out cannot consume the capacity an interactive session is bound to |
| `060_quota_cache_domains.md` | wp6 | Credentials are grouped by observed quota and cache domain, not by string identity |
| `070_delivery.md` | wp7 | Delivery, verification posture, and merge policy |

wp2 and wp3 are the incident. wp4 through wp6 are the amplifiers that turn a
routing mistake into a cost event; they ship after the incident is closed.

## Relationship to #4581

The L2 lane unit `devlog/_plan/260914_l2_pool_routing_cache/010_cache_safe_rebind.md`
reached the headroom floor by a different route -- keep the threshold eviction rule,
constrain the destination -- and landed on `dev` as #4581 while this unit was in
flight. That analysis is correct and this work **builds on it** rather than beside
it: `pickCacheSafeQuotaReplacement` is the shipped destination rule and both call
sites here use it unchanged.

What it deliberately left open, recorded in its own review, is this unit's scope: a
below-threshold sibling still takes the thread once, so the prefix is lost one time
before affinity goes sticky; cache affinity was still opt-in; and the transient path
was untouched. A headroom floor alone still evicts a live session from an 85%
account to a 5% account, which discards a warm prefix for a capacity preference the
session never had. Holding the binding is the primary rule; the headroom floor is
what protects the operator who explicitly opts back out.

## Write scope

Permitted: `src/codex/routing.ts`, `src/types/config.ts`, `src/config.ts`, the
account-pool and session-affinity code, `src/routing/` for the identity, quota and
cache-domain layers `090_remaining_stack.md` plans (wpc's classifier, wpe's reservation
ledger, wpf's probe lease), their tests under `tests/codex-integration/` and
`tests/routing/`, `docs-site/` configuration reference and its locales,
`structure/` docs that own the affected invariants, and this unit.

Excluded, owned by concurrent lanes: `src/providers/devin*`,
`src/providers/antigravity*`, `src/server/responses/*`, `src/codex/catalog/*`,
`src/adapters/cursor/*`, `gui/`.

## Verification posture

Local suite, typecheck, install and GUI build are **not run** for this unit by
explicit instruction. Proof is hosted CI at the exact final head SHA and nothing
else. Pull requests state that posture in their Verification section rather than
implying a local green. Pushes use `--no-verify`.

## Acceptance criteria

1. With no `pool` key configured, a bound thread in the 80–99% band keeps its
   account across repeated resolves, and the preview path agrees with resolve.
2. `pool.cacheAffinity: false` restores the historical eviction rule, and under it
   a bound thread still refuses to move to a destination without headroom.
3. A transient failure streak routes the current request away from the account
   without deleting the binding; once the streak clears the thread is served by
   its original account again.
4. Quota refusal, credential invalidation, generation bumps, pause, and TTL expiry
   still release a binding, with their existing tests unchanged.
5. Every live-binding move records a reason that names which of those causes fired.
6. Hosted CI is green at the exact final head of each delivery branch.

## What would make this fail

Shipping the default flip without finding every test that encodes the old default,
and calling a red CI run a flake. The blast radius is enumerated in `010`; it is
not guesswork, and a surprised assertion is evidence the rule is wrong somewhere,
not that the test is stale.
