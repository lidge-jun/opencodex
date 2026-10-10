# wp1 — a bound thread may only move to an account that has headroom (#4546)

## What the code does today

`resolveCodexAccountForThreadDetailed` reuses a live thread binding and then calls
`reevaluateAffinityQuota`. Under the `quota` strategy that helper computes the bound
account's usage score and asks `mayRebindAffinityForQuota`, whose default answer is
`usage >= autoSwitchThreshold` (80). When that is true it calls `pickLowerUsageAccount`,
which returns whichever eligible account is **strictly cooler** — by any margin at all.

Two consequences, both reported:

1. Because `mayRebind` is also what short-circuits the 60 s re-score interval, a thread in the
   80–100 % band is re-scored on **every request**, not once a minute.
2. "Strictly cooler" has no floor. Once every account sits at 95–99 %, the coolest is still
   over the threshold, so the thread is handed from account to account on consecutive turns.

Codex prompt caches are tenant-isolated, so each hop starts from a cold prefix. The reporter
measured a 7k-token turn becoming a 150k-token turn, 1.9 B tokens across 15,607 requests in
about 13 hours on five accounts.

## The rule to add

A live binding may only be moved to an account that has **genuine quota headroom** — the same
bar `resetFirstAffinityReplacement` already applies for the `reset-first` strategy via
`hasCodexQuotaHeadroom`. Quota strategy is the outlier, and that asymmetry is the defect.

Consequences of the new rule, which are what the regression test pins:

- Every account over the threshold ⇒ no candidate has headroom ⇒ the thread stays put and keeps
  its cache. There is nothing to win by moving: the destination is as hot as the origin.
- A cool account exists ⇒ the thread still moves, exactly once, and lands somewhere it can stay.
  Movement is now bounded by the number of accounts rather than by the number of turns.
- Nothing changes for an **unbound** request: cascading fresh single-turn work onto the coolest
  account is correct, because there is no warm prefix to lose.
- Release paths are untouched. `hasUnrecoveredCodexQuotaRefusal` (429/402) still outranks every
  affinity preference, `shouldFailover` still applies, and an exhausted or unusable account still
  loses the binding. The rule narrows a *preference*, never a refusal.
- One correction from review: a known score of 100 with **no** recorded refusal is not by itself a
  release path today, and this change does not make it one. Such a thread stays while its account is
  still selectable, and surrenders the binding as soon as a sibling with headroom exists. Stickiness
  until the account actually refuses is intended, so the regression test asserts that and not the
  stronger claim.

## Where it goes

The rule exists in two places that the suite asserts answer identically, so both change together:

- `reevaluateAffinityQuota` — the live resolve path.
- `previewReusableAffinityAccount` — the side-effect-free preview used for subagent fallback.

Headroom alone is not sufficient, because `hasCodexQuotaHeadroom` deliberately answers **true**
for an account whose usage is unknown — unknown-means-selectable is the right default for an
unbound request. It is the wrong bet for a bound one: trading a warm prefix for an unmeasured
account is a guess, not an improvement. So the candidate must clear both bars, headroom **and**
strictly lower usage than the bound account. `CODEX_UNKNOWN_USAGE_SCORE` is 101, so an
unobserved account can never be strictly cooler than a known over-threshold score and the second
bar excludes it without a special case. An unknown-usage *bound* account never rebinds today
either, because `mayRebindAffinityForQuota` requires a known score.

## Regression test

Next to the existing pool-rotation tests in `tests/codex-integration/`. Three cases:

1. All accounts over the threshold: the bound thread's account is unchanged across repeated
   resolves — the ping-pong case, which fails before the fix.
   The scores must be UNEQUAL (95 / 90 / 97). Equal scores would not move even before the fix, so an
   equal-score fixture would pass for the wrong reason and prove nothing.
2. One account below the threshold: the bound thread moves to it once, then stays.
3. Preview agrees with resolve in both situations.

`pickLowerUsageAccount` itself must not change: it is shared with `applyQuotaAutoSwitch` and the
unbound selection path, so the new bar belongs at the two bound-thread call sites only.
