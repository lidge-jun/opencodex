# Phase 1 — an operator pick beats the pool cursor (Codex)

Base: `origin/dev` `dd9a2906b`. Branch: `codex/pool-manual-selection` off `dev`.
Precondition: lane L3 owns `src/codex/routing.ts` and `src/codex/auth-api.ts`
(000_plan.md constraints). Do not open this layer until that ownership clears.

## Thesis

A manual selection from the dashboard or `ocx account use` wins the next dispatch,
and commits as the stored active account when that dispatch succeeds.

## Current behaviour (verified on dd9a2906b)

```
src/codex/routing.ts
  56   let runtimeActiveCodexAccountId: string | undefined;
  1625 export function getEffectiveActiveCodexAccountId(config: OcxConfig): string | undefined {
  1626   return runtimeActiveCodexAccountId ?? config.activeCodexAccountId;
  1644 function rememberActiveCodexAccount(_config: OcxConfig, accountId: string): void {
  1645   runtimeActiveCodexAccountId = accountId;
```

`rememberActiveCodexAccount` is called at `:1470` (round-robin commit), `:1481`
(fill-first commit), `:1678` (`promoteActiveCodexAccount`) and `:2286`
(preemption). None of the four consults the pin. The pin itself
(`config.activeCodexAccountPinned`, written only by `auth-api.ts:2441`) is read as
a priority-tier ceiling in `getEligiblePoolAccounts` `:1318-1322` and nowhere else
in the selection path.

The path to copy is Anthropic's:

```
src/oauth/anthropic-routing.ts
  94  let manualPreference: OAuthAccountSelection | null | undefined;
  575 if (manualPreference === undefined) { ...seed from set.activeAccountId + selectionRevision }
  588 if (manualPreference.accountId !== set.activeAccountId || revision mismatch) manualPreference = null;
  597 return { accountId: chosen, reason: "manual" };
  799 // consumed only after the admission commit
  808 export function resetAnthropicRoutingForManualSelection(accountId: string)
```

## Change surface

MODIFY `src/codex/routing.ts`

1. NEW `manualPreference`, keyed by pool scope rather than a singleton:
   `Map<poolKey, { accountId: string } | null>` beside `runtimeActiveCodexAccountId`
   (`:56`), keyed by `codexPoolKeyForScope` (`:225`). A singleton would let an
   independent quota scope (spark, reserve) apply or consume the shared one-shot,
   because `isIndependentCodexQuotaScope` deliberately isolates those from the
   shared `remember` path. An absent entry means not yet seeded; `null` means
   consumed.

   Seeding is explicit only. The entry is written by
   `resetCodexRoutingForManualSelection` and nowhere else. There is no lazy seed
   from `config.activeCodexAccountId` on first read, because an absent entry plus a
   lazy seed would let an independent quota scope invent a preference it was never
   given.

   Invalidation, since Codex has no account-side equivalent of Anthropic's
   `selectionRevision` (`apiKeySelectionRevision` is for keys and the store
   `generation` is credential lineage): the preference is dropped only by an
   OPERATOR-driven change of the active account, meaning another
   `resetCodexRoutingForManualSelection` naming a different account, or an explicit
   clear. A POOL-driven move must not drop it.

   That distinction is load-bearing and was missed twice. An earlier draft said
   "drop it whenever the accountId no longer equals the persisted active account",
   which contradicts the guarantee below: `promoteActiveCodexAccount` (`:1677`)
   calls `releaseCodexAccountPinFor` and then `setActiveCodexAccount` (`:1660`,
   which clears `runtimeActiveCodexAccountId` at `:1661`) BEFORE it would reach the
   guarded `remember`. Under the old rule a failover promote would move the
   persisted active, look like a mismatch, and silently spend the operator's
   one-shot. Keying invalidation to the operator path instead of to value equality
   is what keeps F1 and F4 from cancelling each other.
2. `resetCodexRoutingForManualSelection` (`:870`) additionally seeds
   `manualPreference` from `config.activeCodexAccountId`, mirroring
   `anthropic-routing.ts:810`. It keeps clearing thread affinity, clearing the
   runtime cursor and seeding round-robin, and keeps preserving cooldown.
3. The guard sits on BOTH writers, not only on `remember`.
   `rememberActiveCodexAccount` (`:1644`) becomes a no-op while a live preference
   names a different account, which closes its four call sites `:1470`, `:1481`,
   `:1678` and `:2286` at once. That alone is still insufficient, because
   `promoteActiveCodexAccount` (`:1677`) releases the pin and calls
   `setActiveCodexAccount` (`:1660`) before it ever reaches `remember`. So
   `promoteActiveCodexAccount` and `setActiveCodexAccount` also check for a live
   preference and leave the operator's account in place for the pool-driven paths
   (failover `:1878`, model detour `:2213`, exclusion `:1704`, cooldown `:2534`
   and `:2584`). An operator PUT still moves them, because that path seeds a new
   preference first.
4. `getEffectiveActiveCodexAccountId` (`:1625`) returns the preference account
   while one is live, ahead of the runtime cursor.
5. `resolveCodexAccountForThreadDetailed` (`:2069`) checks the preference before
   `pickUnboundStrategyAccount` (`:2194`). If the preference account is selectable
   and not exhausted, return it with a `manual` reason and do not call
   `rememberActiveCodexAccount`. Honouring does NOT require the preference to still
   equal `config.activeCodexAccountId`: a pool-driven promote may legitimately have
   moved that value, and treating the difference as staleness is the mistake the
   audit rejected twice.
6. `previewCodexAccountForRequest` (`:1987`) peeks the preference without
   consuming it.
7. NEW consume-on-success, mirroring `anthropic-routing.ts:799-800`. Codex has no
   equivalent of the Anthropic admission commit, so the hook must be named
   explicitly: consume at the same point that already records a successful upstream
   outcome for the resolved account, `recordCodexUpstreamOutcome`, and only for a
   non-quota success. Consuming must call `setActiveCodexAccount` rather than only
   nulling the entry, because nulling alone leaves `runtimeActiveCodexAccountId`
   pointing at the pool's earlier pick and the next dispatch would silently return
   to it. A failed lookup must not spend the preference.

MODIFY `src/codex/auth-api.ts` PUT `/api/codex-auth/active` (`:2412-2444`):
no contract change. It keeps `setCodexAccountPin` and
`resetCodexRoutingForManualSelection`; the pin stays the tier ceiling and the new
preference carries the one-shot. A null body still clears the pin (`:2440`).

Explicitly NOT changed: `applyQuotaAutoSwitch` (`:1784`). It only moves at
`autoSwitchThreshold`, and `releaseDrainedCodexAccountPin` (`:1757`) already
treats that drain as the end of a pin. An earlier draft named it as the cause and
the audit rejected that. Goalplan criterion c-2 therefore already holds on `dev`;
what is missing is not behaviour but proof, so this layer adds the test rather
than the code.

## Tests

Extend, do not add files. `codex-` is not in the `layout.json` domain regex, so a
new `codex-*.test.ts` would need entries in both `scripts/test-layout/layout.json`
`explicit` and `tests/fixtures/test-layout-expected.json`.

- `tests/codex-integration/codex-pool-rotation.test.ts` — the operator pick wins the
  next round-robin and fill-first dispatch (manual seed cases at `:524-541`); the
  existing pin-holds-RR case at `:791-803` stays green for the ceiling after the
  preference is consumed.
- `tests/codex-integration/codex-routing.test.ts` — a second unbound session follows
  the pool cursor again once the preference is spent; a failed admission leaves the
  preference unspent (pin cases at `:3139-3242`).
- `tests/codex-integration/codex-auth-api.test.ts` — PUT then next-dispatch identity
  (`:3956-3989`).

Semantic oracle: `tests/adapters/anthropic/anthropic-account-pool.test.ts` `:144`,
`:209`, `:234`.

Added after the A-phase audit, because the three files above prove the ceiling and
the drain but not these:

- a live preference survives `promoteActiveCodexAccount` reached through failover
  and through a model detour, and survives a priority preemption
- an independent quota scope neither applies nor consumes the shared preference
- an operator selecting a different account replaces the previous preference, while
  a pool-driven promote that moves the persisted active account does not spend it
- criterion c-2 directly: with a pinned account that is selectable and under
  `autoSwitchThreshold`, auto-switch holds, under both the quota strategy and
  round-robin or fill-first

## Out of scope

## Audit record

The A-phase reviewer returned FAIL with one blocker and four majors, all folded
above: the overwrite hole at `promoteActiveCodexAccount` and preemption, the
singleton-versus-scope-keyed state, the missing invalidation rule in the absence
of an account-side revision, the pin-versus-preference disagreement after a
released pin, and the test gap against criterion c-2.

## Implementation-entry audit, after the lane freeze lifted

Lane L3 PR #4230 and lane L1 PR #4226 merged, so this work became writable. A
fresh audit against the post-merge file returned FAIL with three more blockers.
All anchors survived the merge (`codexPoolKeyForScope` 225,
`resetCodexRoutingForManualSelection` 870, `pickUnboundStrategyAccount` 1446,
`getEffectiveActiveCodexAccountId` 1625, `rememberActiveCodexAccount` 1644,
`setActiveCodexAccount` 1660, `promoteActiveCodexAccount` 1669), but L3 added
independent-scope cursor isolation and runtime-only preemption, which changes what
the design may assume.

1. **BLOCKER. The preference is scope-keyed but `getEffectiveActiveCodexAccountId`
   is not.** It takes only a config and has no `quotaScope`, so it can read the
   shared `POOL_KEY_CODEX` entry and nothing else. `resolveCodexAccountForThreadDetailed`
   and `previewCodexAccountForRequest` look up `codexPoolKeyForScope(quotaScope)`
   themselves. A scope with no entry means NO preference; it must never fall back to
   the shared key, or an independent scope would consume a one-shot it was not given.
2. **BLOCKER. Consuming inside `setActiveCodexAccount` is wrong.** That function is
   also the persist path for pool-driven moves: quota auto-switch (1807), affinity
   re-evaluation (2166), unbound persist (2231 and 2252) and the quota promote
   (1671) all call it. Consuming there would let the pool spend the operator's
   one-shot. Consume only on the path where the preference was actually honoured
   and the dispatch succeeded, plus on an operator reset.
3. **BLOCKER. An unconditional honour traps a cooled account.** With
   `rememberActiveCodexAccount` a no-op, a 429 or failover on the preferred account
   (2527, 2576, 1878) could not move `getEffectiveActiveCodexAccountId` away from
   it. Honour the preference only while that account is selectable and not cooling;
   otherwise treat it as absent for this dispatch without spending it.
4. **The preview path must mirror resolve.** The check belongs immediately before
   BOTH `pickUnboundStrategyAccount` calls, at 2020 and 2193, after affinity and
   model-detour handling, not at function entry.
5. **Pause and exclusion never route through the reset.** `reconcileCodexActiveAfterExclusion`
   (1692) and the health-clear path (317-320) bypass it, so a preference would
   outlive an excluded or paused account. Drop the key when the preferred account is
   excluded or paused.
6. **Minor, but decide it deliberately.** `isEffectiveCodexAccountPinned` (1637)
   would read true while the preference equals the pin, and L3 now documents that
   `getEffectiveActiveCodexAccountId` is what surfaces automatic picks to the API
   and dashboard. Either keep the pin check reading persisted and runtime only, or
   accept and document that `GET /api/codex-auth/active` is manual-sticky until the
   preference is consumed.

## Measured: the consume call site is the whole design, not a detail

A first implementation pass built the preference map, the seeding inside
`resetCodexRoutingForManualSelection`, the `rememberActiveCodexAccount` guard, the
`getEffectiveActiveCodexAccountId` overlay and the exclusion revoke, and left the
consume call site unwired. It typechecked, and then
`tests/codex-integration/codex-pool-rotation.test.ts` went from green to **15 failures
out of 69**, including "fill-first picks the same sequence with no stored order as
before the feature".

That is the correct result, and it is worth recording rather than repeating. Without a
consume site the one-shot is permanent: the first operator selection freezes the
automatic cursor forever, because `rememberActiveCodexAccount` stays a no-op and no
code path ever clears the entry. Every rotation-strategy test that expects the pool to
keep moving after a manual selection fails, and they are right to.

So the implementation order matters. Build the consume path FIRST, not last:

1. Find the point that already records a successful upstream outcome for the resolved
   account and call `consumeCodexManualPreference(poolKey)` there, for a non-quota
   success only. This is the Codex analogue of `commitAnthropicSelectionRouting`
   (`anthropic-routing.ts` :799-800), which Codex has no direct equivalent of.
2. Only then add the `rememberActiveCodexAccount` guard, so the suite never passes
   through a state where the cursor can freeze.
3. Gate honouring on the account being selectable, per blocker 3 above, so a cooled
   preferred account is skipped for that dispatch without being spent.

The pass was reverted rather than pushed. The branch `codex/manual-selection-wins`
carries this document and no source change.

## Measured again: guarding the writer is right, but the 429 path needs an exemption

A second pass followed the order above. The consume site went in first, at the
`outcomeClass === "success"` branch of `recordCodexUpstreamOutcome` (:2356), keyed by
`codexPoolKeyForScope(quotaScope)` which that function already computes. Seeding and the
exclusion revoke followed. At each of those two steps
`tests/codex-integration/codex-pool-rotation.test.ts` stayed **69 pass, 0 fail**, which
confirms the ordering advice above is correct.

Adding the `rememberActiveCodexAccount` guard then produced **6 failures out of 69**, down
from 15, and every single one is a 429 promotion case:

- fill-first 429 advances to next stable account, not lowest usage
- RR 429 promotes via ring, not lowest usage
- 429 retry reuse promoteAccountId avoids a second RR ring advance
- fill-first transient failover advances stable order, not lowest usage
- scoped reset 429s retain strategy while excluding only the affected native quota
- fill-first preserves its pre-feature fallback when every ordered tier is drained

That is exactly the hazard blocker 3 named, and it is sharper than the blocker stated it.
Gating the guard on `isCodexAccountSelectable(preferred)` is NOT sufficient: at the moment
`promoteActiveCodexAccount` runs, the preferred account can still read as selectable
because the 429 cooldown is recorded on a different path, so the guard holds and the
promotion cannot land.

The conclusion for the next pass: guarding the writer closes all four call sites at once,
which is still the right shape, but the failover promote needs an explicit exemption. It
only ever runs because the account in use just failed, so it is never an automatic pick
competing with the operator. Either pass an explicit "this is a failover promote" flag
through `rememberActiveCodexAccount`, or leave the writer unguarded and guard the two
strategy commit sites plus preemption instead, accepting three guards rather than one.

Reverted again rather than pushed. The measurement is the deliverable.

The generic OAuth kind gets no preference in this layer; that arrives with the
kernel in phase 2. No management or GUI change.

## Staleness re-verification

Re-verified at the wp1 P entry against `origin/dev` `16f18d654`, after lane L3
landed `de1d88739`, `abec9ee51` and `7f91737c2` on the owned files. Every anchor
this document depends on is unchanged from the `dd9a2906b` reading:

| Symbol | Line on 16f18d654 |
|---|---|
| `getEffectiveActiveCodexAccountId` | 1625 |
| `rememberActiveCodexAccount` | 1644 |
| `applyQuotaAutoSwitch` | 1784 |
| `resetCodexRoutingForManualSelection` | 870 |
| `pickUnboundStrategyAccount` | 1446 |
| `releaseDrainedCodexAccountPin` | 1757 |

The design therefore survives the lane's landings. What does not change is the
coordination risk: L3 still owns these files for the dispatch round, so the B
phase of this work-phase must not open until that ownership clears. Re-run this
table at that point, because the guarantee above is a snapshot of `16f18d654`.

## Audit round 4 — the shipped tests proved nothing

The first implementation landed as PR #4284 with three new cases under
`an operator selection outranks the pool cursor`, and a reviewer was asked one
question the earlier rounds never asked: does each test fail without the production
change? It does not. Measured by reverting only `src/codex/routing.ts` to the parent
branch and keeping the new tests:

```
bun test tests/codex-integration/codex-pool-rotation.test.ts \
  -t "an operator selection outranks the pool cursor"
3 pass, 0 fail          # production change reverted
```

All three passed against a tree with no guard, no preference map and no consume site.
They were re-assertions of things that already held: case 1 of
`resetCodexRoutingForManualSelection` clearing the runtime cursor and seeding the ring,
cases 2 and 3 of the failover promote, which this design deliberately leaves exempt. A
test that cannot fail is not weak coverage, it is an empty claim, and criteria c-1 and
c-2 had been recorded `met` against it.

Three real defects were behind that blind spot.

**Deletion never revoked the preference.** Pause and exclusion both route through
`reconcileCodexActiveAfterExclusion`, which forgets it. Delete does not: the
account-lifecycle path reaches routing through `clearCodexUpstreamHealthForAccount`
(`routing.ts:327`, called from `account-lifecycle.ts:43`), which cleared two health maps
and left the preference behind. Once the named account is gone nothing can ever succeed
on it, so the one-shot can never be spent, and every later automatic write is suppressed
until the process restarts. The generation sweep in `reconcileCodexRoutingHealth` had the
same hole for an account removed by an edit the runtime never observed.

**The model-detour promote was reported as unguarded — REBUTTED.** `promoteActiveCodexAccount`
at the model-detour site sits twelve lines above the preemption site this design guards, so
the symmetry argument is tempting. It is wrong, and the measurement says so: guarding it
fails 8 cases in `tests/codex-integration/codex-routing.test.ts`, the
`cannot re-pick a quota-drained shared account that remains model-eligible` family and its
siblings. Those encode an older contract. A model detour is not the pool exercising
discretion — it runs because the operator's account cannot serve the requested model at
all — and under a rotating strategy that promote moves only the process-local cursor to
whoever is actually serving, then releases the pin. `config.activeCodexAccountId`, the
operator's persisted selection and the thing this preference exists to protect, is
untouched either way. The guard was written, measured red, and reverted with the reason
recorded at the call site.

**The independent-scope entries were dead state.** Every write site the guard protects is
already skipped for independent scopes, so those keys were seeded and consumed but never
read. Removed: state nothing reads is what the next reader mistakes for a rule.

The replacement cases are each red against the variant that removes the piece they cover:

| Case | Red against |
|---|---|
| an over-threshold operator account is served around, not replaced | parent branch: reads `b`, expected `a` |
| deleting the preferred account releases the hold | pre-fix head `63217d161`: reads `undefined`, expected `b` |
| a successful dispatch spends the one-shot so the pool may move again | guard without consume: 15 of 69 rotation tests fail |

The over-threshold case is also the one that states the user-facing rule plainly. An
account past its switch threshold is temporarily spent, not wrong: the pool serves the
request from elsewhere, and the operator's selection stays pointed where the operator put
it, so the window rolling over returns routing to it without a second manual pick.
