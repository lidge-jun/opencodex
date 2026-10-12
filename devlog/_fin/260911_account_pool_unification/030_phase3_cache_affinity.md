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

## wp3 plan — what criterion c-4 actually requires

This phase was recorded as blocked on three product decisions: the shared affinity key shape,
the shared-cohort `prompt_cache_key` fallback, and a minimum-token cache gate. Re-reading the
criterion against the code shows none of the three is on the path to it.

> c-4: Account selection consults cache affinity before quota for subscription pools, proven by
> a test where the cache-affine account is chosen over a higher-headroom one.

That is a statement about **ordering**, not about key shape. The phase title pairs ordering with
"a unified affinity key", but only the ordering half is an acceptance criterion, and the two are
separable: reordering uses each kind's EXISTING affinity binding and introduces no new key.
Assumption 1 gates the unified key, not this. Assumption 2 is a property of the Anthropic
session-key derivation, which the ordering change does not touch. Assumption 3 is explicitly
optional in the original text ("decide whether to implement") and is not required by c-4.

So the unified key stays open and stays out of this cycle. The ordering ships now.

## Only one kind actually breaks cache affinity

Verified on the branch head rather than assumed:

- **Anthropic already honours affinity unconditionally.** `src/oauth/anthropic-routing.ts`:604-610
  returns `{ reason: "affinity" }` whenever the affined account is present, not reauth-flagged,
  not cooled and credential-usable. `autoSwitchThreshold` governs NEW-session picks
  (`anthropicAutoSwitchThreshold`, :111) and never rebinds a live session.
- **Codex does not.** `reevaluateAffinityQuota` (`src/codex/routing.ts`:2031) rebinds a live
  thread whenever the quota strategy is active and usage crosses `autoSwitchThreshold` (:2047),
  which throws away a warm prompt cache on a hint rather than on evidence.
- The generic OAuth kind has no affinity at all, so it has nothing to reorder.

That makes this a one-function change, and it makes the criterion's "pools" plural satisfiable:
after it, both subscription pools keep a bound conversation on its account until that account
genuinely cannot serve.

## Change surface

`src/codex/routing.ts`, `reevaluateAffinityQuota` only. Under `pool.kernel`, the rebind bar
stops being "crossed the threshold" and becomes the same **drained** test the pin-release path
already uses (`releaseDrainedCodexAccountPin`, :1866):

```
!isCodexAccountUsable(config, entry.accountId, selectionOptions)
  || !hasCodexQuotaHeadroom(config, entry.accountId, selectionOptions, now)
```

Reusing that predicate rather than inventing a second notion of "spent" is deliberate: two
definitions of exhausted in one file is how they drift. The reeval-interval short circuit keeps
its current shape so a bound thread is still not re-scored more than once a minute.

Flag off restores today's behaviour exactly, which is what makes shipping this without the three
open decisions safe rather than presumptuous.

## Acceptance

- A bound thread on an account at 90% usage with `autoSwitchThreshold: 80` and a sibling at 10%
  KEEPS its account while the flag is on — the cache-affine account chosen over the
  higher-headroom one, which is c-4 verbatim.
- The same fixture with the flag off still moves, so the old behaviour is provably intact.
- A bound thread whose account is genuinely drained still moves with the flag on, so the change
  is a reordering and not a pin.
- Red control: with the flag branch removed, the first case must fail.

### wp3 plan audit — FAIL, folded

**Blocker 1 — the "drained" bar I proposed IS the threshold.** `releaseDrainedCodexAccountPin`
reads `!isCodexAccountUsable || !hasCodexQuotaHeadroom`, and `hasCodexQuotaHeadroom`
(`src/codex/routing.ts`:1387-1395) is `usage < (autoSwitchThreshold ?? 80)`. Reusing it inside
`reevaluateAffinityQuota` would have preserved today's 80% rebind exactly, so the plan's own
acceptance case — a bound thread at 90% with threshold 80 KEEPING its account — could not have
passed. The argument for reuse ("don't invent a second notion of spent") was right in spirit and
wrong in fact: the pin path deliberately releases at the auto-switch crossing, which is a
different question from whether the account can still serve.

The bar this phase needs is genuine exhaustion, and it is not expressible as the existing
predicate. Definition used instead, local to the reeval and stated once:

```
spent = !isCodexAccountUsable(config, id, selectionOptions)   // reauth, excluded, cooled
     || (!isUnknownUsage(usage) && usage >= 100)              // allowance actually gone
```

Per minor 7 the usable half is already guaranteed by the caller, which requires
`isCodexAccountSelectable`, so in practice the test reduces to the usage half — kept explicit
anyway so the predicate reads correctly on its own.

**Major 3 — `previewReusableAffinityAccount` duplicates the same threshold move.**
`src/codex/routing.ts`:1984 carries its own copy for the preview path. Changing only the
mutating site would make `previewCodexAccountForRequest` disagree with
`resolveCodexAccountForThreadDetailed` — and the suite already contains cases asserting those
two agree. Both move together.

**Major 4 — the reeval interval must stop keying off the old bar.** The short circuit stamps
`lastReevalAt` only when `overThreshold`, so leaving it as-is while the rebind bar changes
re-scores a thread on every request through the whole 80-99% band. The short circuit follows the
new bar, keeping the once-a-minute ceiling intact.

**Minor 6, taken — the flag is wrong.** `pool.kernel` is the generic-OAuth strategy-consume
flag introduced in wp2b; reusing it for a Codex affinity rule would overload one switch with two
unrelated meanings and make either one impossible to turn on alone. This uses its own
`pool.cacheAffinity`, defaulting off.

**Minor 5 recorded.** `tests/codex-integration/codex-routing.test.ts` contains cases that require
the immediate over-threshold switch. They stay green because the flag defaults off, and that is
the check that proves flag-off is byte-identical rather than merely claimed.

### Major 2 — rebutted, with its limit stated

The audit is right that today's stickiness is keyed on thread and session identity rather than
on a cache key, and that a thread-keep test therefore proves "identity stickiness outranks
quota", not "a measured cache is consulted". That distinction is real and is exactly what the
deferred unified key would close.

It does not block c-4. In this codebase the thread/session binding IS the mechanism by which a
warm prompt cache stays reachable: the cache lives on the account that served the conversation,
so keeping the conversation there is what preserves it. c-4 asks that the affine account win
over a higher-headroom one, and after this change it does. What remains open — and is recorded
as open rather than quietly satisfied — is making the binding explicitly cache-derived instead
of identity-derived. The criterion's plural "pools" is likewise honest only because Anthropic
already holds its live sessions; this change brings Codex to the behaviour Anthropic has, rather
than adding a second implementation.

### The "## Change surface" block above is SUPERSEDED

It still names `pool.kernel`, `hasCodexQuotaHeadroom` and `reevaluateAffinityQuota` alone.
Implementing it as written fails three of the folded findings and cannot pass the 90% keep case.
The fold is the spec. Concretely, the build is:

- `src/types/config.ts` and `src/config.ts` — `pool.cacheAffinity?: boolean`, default off.
- `src/codex/routing.ts` `reevaluateAffinityQuota` AND `previewReusableAffinityAccount` — both
  copies swap the rebind bar to `!isCodexAccountUsable || (!isUnknownUsage(usage) && usage >= 100)`
  when the flag is on, and the `lastReevalAt` short circuit keys off that same bar.

The pre-audit block stays as the record of what was planned before the audit rather than being
rewritten to look correct.
