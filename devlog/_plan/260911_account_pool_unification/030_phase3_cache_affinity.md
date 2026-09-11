# Phase 3 — cache affinity ranks ahead of quota

Base: the phase-2 layer, and all three open assumptions in 000_plan.md closed
first. This is the speculative layer and does not ride the first train.

## Thesis

For subscription accounts, moving account destroys the prompt cache, so affinity
is consulted before quota. For API keys it is not, which is why phase 4 keeps a
different policy.

## Current behaviour (verified on dd9a2906b)

Stickiness exists but is not cache-driven.

Codex binds on thread identity: codexPoolAffinityKey (src/codex/auth-context.ts)
from x-codex-parent-thread-id or an HMAC of session and thread id, bound by
bindThreadAffinity (routing.ts:1262), read at :1090. LRU cap
CODEX_THREAD_AFFINITY_MAX_ENTRIES = 2048 (:135), pruned oldest-first at
:1211-1234, idle TTL 24h (:134).

Anthropic binds on a session key: anthropicSessionKeyFromParts
(anthropic-routing.ts:877) prefers client, session and thread id and treats
promptCacheKey as a last resort, discarding it entirely when
promptCacheKeyIsSharedCohort (:894). Cap MAX_AFFINITY_ENTRIES = 2000 (:48),
evict oldest by lastUsedAt (:468-471).

Generic OAuth has no affinity at all (module comment :1-15).

reevaluateAffinityQuota (routing.ts:1942) may rebind a live thread when the quota
strategy is active and usage passes autoSwitchThreshold (:2164-2170); round-robin
and fill-first stay sticky (:2157-2160).

accountPoolStickyLimit is not a binding-count cap. It is the number of successful
binds retained on one round-robin selection, default 1 (src/types/config.ts:841,
pool-rotation.ts:167-171 and :204-216), so at the default it never even sets
activeKey. The real caps are the two LRU limits above.

No minimum-token cache gate exists anywhere: there is no cacheThreshold or
minCacheTokens, and applyPromptCaching (src/adapters/anthropic.ts:100) places
cache_control without a size check. MAX_CACHE_BREAKPOINTS = 4 (:60) is the only
real cache numeric.

## Open assumptions this phase must close first

1. Affinity key shape. Codex keys on thread, Anthropic on session. Proposed
   shared shape, to confirm before implementation: a composite of tenant,
   conversation, provider and model, which is what cache-affine proxy practice
   recommends over hashing the request body.
2. Shared cohort. Today a shared-looking prompt_cache_key discards affinity
   entirely. Decide whether to fall back to another identifier instead.
3. Minimum cache size. Decide whether to implement a minimum-token gate and the
   Anthropic 1024 and 2048 breakpoint minimum locally.

## Change surface (provisional, re-verify at P)

NEW src/oauth/affinity-key.ts - one composite key builder used by Codex,
Anthropic and the generic kind through the phase-2 kernel.

MODIFY the kernel selection order so that, for pools marked cache-sensitive, a
live affinity binding outranks a higher-headroom candidate unless the affine
account is exhausted. Key pools are not marked cache-sensitive.

MODIFY reevaluateAffinityQuota so a rebind requires exhaustion rather than merely
passing the threshold, because a threshold rebind throws away a warm cache.

## Tests

A cache-affine account is chosen over a higher-headroom one; an exhausted affine
account still yields; concurrent distinct sessions keep distinct accounts; a
shared-cohort cache key does not collapse every session onto one account.

## Staleness re-verification and why this phase is not open yet

Re-verified at the wp3 P entry against `origin/dev` `1da8dae96`. Every anchor this
document relies on is unchanged from the original reading:

| Symbol | File | Line |
|---|---|---|
| `CODEX_THREAD_AFFINITY_MAX_ENTRIES` | `src/codex/routing.ts` | 135 |
| `pruneLruThreadAffinities` | `src/codex/routing.ts` | 1212 |
| `reevaluateAffinityQuota` | `src/codex/routing.ts` | 1942 |
| `MAX_AFFINITY_ENTRIES` | `src/oauth/anthropic-routing.ts` | 48 |
| `anthropicSessionKeyFromParts` | `src/oauth/anthropic-routing.ts` | 877 |
| `promptCacheKeyIsSharedCohort` | `src/oauth/anthropic-routing.ts` | 883 |
| `MAX_CACHE_BREAKPOINTS` | `src/adapters/anthropic.ts` | 60 |

The design is therefore current. Two things still stop this phase from opening,
and neither is a documentation gap:

1. **Its three open assumptions are genuine product decisions, not research gaps.**
   The affinity key shape, what to do when a `prompt_cache_key` looks like a shared
   cohort, and whether to add a minimum-token cache gate all change observable
   behaviour and none is settled by reading the code. They need a human answer.
   Under an active goal the Interview is suppressed, so this phase cannot resolve
   them from inside the loop.
2. **The Codex half is frozen.** `src/codex/routing.ts` carries three of the seven
   anchors above and is owned by lane L3 for the dispatch round in flight.

The Anthropic and generic halves are not frozen, so a narrower first slice exists:
unify the affinity key for those two kinds only, leaving the Codex thread-affinity
map on its current key until the freeze lifts. That slice still needs assumption 1
answered, which is why this phase stays closed rather than being re-scoped now.
