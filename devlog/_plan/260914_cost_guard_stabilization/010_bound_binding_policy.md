# 010 — wp2: a live binding is held for cache, not re-scored for capacity

## Today

`resolveCodexAccountForThreadDetailed` reuses a live binding, then calls
`reevaluateAffinityQuota`. Under the `quota` strategy that helper scores the bound
account and asks `mayRebindAffinityForQuota` (`src/codex/routing.ts:2235`), whose
answer without `pool.cacheAffinity` is `usage >= autoSwitchThreshold`. When true it
takes `pickLowerUsageAccount`, which returns any **strictly cooler** eligible
account. `previewReusableAffinityAccount` (`:2207`) carries a second copy of the
same rule and the suite asserts the two answer identically.

Two independent defects fall out of that, and they need different fixes.

**The threshold is the wrong question for a bound thread.** Crossing 80% says the
account is getting busy. It does not say the account cannot serve this turn, and
the cost of acting on it is the whole warmed prefix. `round-robin` and
`fill-first` already keep bound threads sticky — rotation there is new-session-only
by design. `quota` is the outlier.

**Nothing constrains the destination.** With every account in the 80–99% band the
coolest is still hot, so the thread is handed on again next turn. `mayRebind` is
also the short circuit for the 60-second re-score interval, so in that band the
thread is re-scored on every request.

## The rules

**R1 — cache-first is the default.** `pool.cacheAffinity` resolves to `true` when
unset. A bound thread leaves only when its account genuinely cannot serve:
unusable, paused, credential-invalid, generation-stale, TTL-expired, quota-refused,
or known to be at 100%. An explicit `pool.cacheAffinity: false` restores the
historical rule for operators who want capacity-first behaviour.

**R2 — a move needs somewhere worth moving to.** Even under R1-off, a bound thread
may only move to an account that has genuine quota headroom, the same bar
`resetFirstAffinityReplacement` already applies for `reset-first` through
`hasCodexQuotaHeadroom`. Headroom alone is not sufficient, because that predicate
deliberately answers true for an account whose usage is **unknown** —
unknown-means-selectable is right for an unbound request and wrong for a bound
one, since trading a warm prefix for an unmeasured account is a guess. The
candidate must clear both bars: headroom, and strictly lower usage than the bound
account. `CODEX_UNKNOWN_USAGE_SCORE` is 101, so an unobserved account can never be
strictly cooler than a known over-threshold score and the second bar excludes it
without a special case.

R2 is what makes the incident impossible for both settings of the flag. R1 is what
makes the expensive case impossible without the operator having to know the flag
exists.

## Why the default flip is the right call and not just a preference

Every comparable system reaches the same place. Upstream Codex has no pool at all:
it pins the cache with a session-scoped `prompt_cache_key` and a turn-sticky
`x-codex-turn-state` token that retries must replay, and its transport sets
`retry_429: false` so a rate-limit answer is classified before anything moves.
Claude Code treats the cache as the retry policy — a `Retry-After` under twenty
seconds waits on the **same** model rather than switching. OpenClaw, which is the
closest analogue because it does pool credentials, auto-pins an auth profile per
session and rotates only on long-window limits, keeping same-key retry separate
from rotation. Published proxy guidance for pooled ChatGPT accounts says the same
thing in one line: pool for quota, pin the session, and do not expect a prefix
warmed on one account to exist on another.

The asymmetry that makes this safe: a session pinned to a busy account pays
latency. A session moved off a warm account pays the entire prefix again, every
turn, and the pool has no way to move the cache with it.

## Where it changes

- `mayRebindAffinityForQuota` — the flag read becomes `?? true`, expressed through
  one resolver so the default lives in exactly one place.
- `reevaluateAffinityQuota` and `previewReusableAffinityAccount` — both gain the R2
  destination filter, together, because the suite pins them to agree.
- `resetFirstAffinityReplacement` — already applies R2; it now shares the helper
  instead of open-coding it.

Release paths are deliberately untouched. `hasUnrecoveredCodexQuotaRefusal`
(429/402) still outranks every affinity preference, generation checks still defeat
a late-arriving failure from an account the thread already left, and an exhausted
or unusable account still loses the binding. This narrows a *preference*; it never
weakens a refusal.

## Blast radius

The default flip inverts tests that encode the old default. They are not stale —
each one pinned real behaviour — so each is rewritten to state its intent
explicitly with `pool: { cacheAffinity: false }`, and a default-on counterpart is
added next to it. The enumeration is mechanical and complete before the edit; see
`.tmp/research/a6-test-blast-radius.md` for the working list. The near-misses
matter as much as the hits: unbound rotation, 429 refusal, cooldown, pause,
failover streak and TTL tests must all keep passing untouched, and any of them
changing is a signal the edit went too far.

## Regression tests

1. No `pool` key, bound thread, account crosses 80% while a 5% sibling exists: the
   thread keeps its account across repeated resolves, and preview agrees.
2. `pool.cacheAffinity: false`, same setup: the thread moves once, then stays.
3. `pool.cacheAffinity: false`, every account in the 80–99% band: the thread does
   not move at all, and does not move on any subsequent turn. This is the reported
   ping-pong and it fails before R2.
4. Known 100% usage on the bound account with a cool sibling: the thread still
   leaves under both settings.
