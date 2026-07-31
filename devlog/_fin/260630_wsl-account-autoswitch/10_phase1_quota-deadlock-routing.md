# 10 - Phase 1: Quota-deadlock routing fix

Purpose: let auto-switch rotate off an over-threshold active account even when
every eligible candidate scores `CODEX_UNKNOWN_USAGE_SCORE`, while leaving
known-quota selection (strict lowest-usage) unchanged.

## Root cause recap (with file:line)

- Unknown sentinel is `100`: src/codex-quota.ts:27 (`CODEX_UNKNOWN_USAGE_SCORE = 100`).
  A candidate with no stored quota scores `100` via `computeCodexUsageScore`
  (src/codex-routing.ts:80, returns the sentinel when `quota` is null).
- Auto-switch only moves on a strict improvement: src/codex-routing.ts:236
  (`if (usage < bestUsage)`) inside `pickLowerUsageAccount`
  (src/codex-routing.ts:231). `bestUsage` is seeded from `activeUsage`
  (src/codex-routing.ts:233).
- The over-budget gate: src/codex-routing.ts:268
  (`if (activeUsage < threshold) return active;`) in `applyQuotaAutoSwitch`
  (src/codex-routing.ts:263).
- Deadlock: when the active account is unknown (`activeUsage = 100`) and every
  eligible candidate is also unknown (`usage = 100`), `100 < 100` is false for
  all candidates, so `pickLowerUsageAccount` returns `active` unchanged and no
  switch fires. This is the WSL symptom: quota is never primed (Phase 20), so
  all accounts sit at `100`.
- Note: the failover and 429 paths use `pickLowestUsageCodexAccount`
  (src/codex-routing.ts:244), same strict `<` (src/codex-routing.ts:249) but
  seeded from `+Infinity` (src/codex-routing.ts:246), so they always return a
  candidate. The deadlock is specific to the quota auto-switch path.

## Proposed change (concrete, minimal)

Keep `pickLowerUsageAccount` strict for the known-data case; add an explicit
all-unknown rotation fallback in `applyQuotaAutoSwitch`. No change to scoring,
thresholds, eligibility, or the failover path.

1. Reuse the existing stable eligibility order from `getEligiblePoolAccounts`
   (src/codex-routing.ts:207); it is config order with main unshifted first, so
   "rotate among unknowns" is deterministic without new state.
2. In `applyQuotaAutoSwitch` (src/codex-routing.ts:263), after the strict pick
   returns no improvement, detect the deadlock and pick a rotation target:

```ts
function isUnknownUsage(usage: number): boolean {
  return usage >= CODEX_UNKNOWN_USAGE_SCORE;
}

// Round-robin among eligible unknown-quota candidates, starting after `active`.
function pickNextUnknownAccount(config: OcxConfig, active: string, now: number): string | null {
  const eligible = getEligiblePoolAccounts(config, active, now)
    .filter(id => isUnknownUsage(computeCodexUsageScore(getAccountQuota(id), getPoolAccountPlan(config, id))));
  return eligible.length > 0 ? eligible[0]! : null;
}

function applyQuotaAutoSwitch(config: OcxConfig, active: string, now: number): string {
  const threshold = config.autoSwitchThreshold ?? 80;
  if (threshold <= 0) return active;
  const quota = getAccountQuota(active);
  const activeUsage = computeCodexUsageScore(quota, getPoolAccountPlan(config, active));
  if (activeUsage < threshold) return active;

  const best = pickLowerUsageAccount(config, active, activeUsage, now);
  if (best !== active) {
    setActiveCodexAccount(config, best);
    return best;
  }

  // Deadlock guard: active is over threshold but no candidate scored strictly
  // lower. When the active itself is unknown, every candidate is likely unknown
  // too (100 < 100 never fires). Rotate to the next eligible unknown so we are
  // not pinned to one account whose real usage we cannot see.
  if (isUnknownUsage(activeUsage)) {
    const next = pickNextUnknownAccount(config, active, now);
    if (next) {
      console.warn(`[codex-routing] quota unknown for active "${active}"; rotating to "${next}" (all candidates unknown, threshold=${threshold})`);
      setActiveCodexAccount(config, next);
      return next;
    }
    console.warn(`[codex-routing] quota unknown for active "${active}" and no eligible rotation target; staying put`);
  }
  return active;
}
```

Why this shape:

- Known data still wins: the strict `pickLowerUsageAccount` runs first and is
  untouched, so a mixed set always picks the truly-lower account before the
  fallback is considered.
- The fallback fires only when `activeUsage` is the unknown sentinel, so a
  known-but-saturated active account (e.g. real `95`) does not bounce to an
  unknown candidate and mask that the whole pool is hot.
- `getEligiblePoolAccounts(config, active, now)` already excludes the active id,
  needs-reauth, cooldown, and unusable accounts (src/codex-routing.ts:207-223),
  so the target is always a legitimate switch.
- The `console.warn` keeps the deadlock loud even when there is no target, which
  is the minimum the MOC asks for under D1 option (c).

## Open decision D1 (recommendation)

D1 (MOC): when all candidates are unknown and active is over threshold, prefer
(a) round-robin, (b) least-recently-used, or (c) stay put + loud log.

Recommendation: (a) round-robin, with the (c) loud log folded in for the
no-target case. Rationale: round-robin needs no new state (the eligibility order
is already deterministic), it breaks the deadlock instead of only narrating it,
and it is the smallest change that makes the WSL user's rotation move. (b) LRU
would need a per-account last-served timestamp that does not exist yet
(`upstreamHealth` tracks failures, not successes), which is more surface than
this phase should add. (c) alone leaves the user pinned to one account, the
original complaint.

If jun prefers strict (c), drop the `setActiveCodexAccount(config, next)` branch
and keep only the warnings; the tests below mark which cases flip.

## Test plan (bun test, tests/codex-routing.test.ts)

Use the existing harness: `makeConfig`, `updateAccountQuota`, `clearAccountQuota`
in `beforeEach`, `saveTestCredential` where selectability matters.

1. all-unknown rotates: config `[a,b]`, active `a`, threshold `80`, no
   `updateAccountQuota` calls. Resolving should move `activeCodexAccountId` off
   `a` to `b`. Asserts the deadlock is broken.
2. all-unknown with no eligible target stays put: single account `a`, active
   `a`, threshold `80`. Active stays `a`, no throw (covers the no-target warn).
3. mixed known/unknown still picks the truly-lower: `updateAccountQuota("a", 10, 90)`
   (active over threshold), leave `b` unknown, add `c` with
   `updateAccountQuota("c", 5, 5)`. Result must be `c`, never `b`.
4. known-but-saturated does not bounce to unknown: `updateAccountQuota("a", 90, 95)`
   active, `b` unknown. Active stays `a` (real `95` is not the sentinel).
5. threshold=0 disables everything: threshold `0`, all unknown, active `a`.
   Active stays `a` (src/codex-routing.ts:265 short-circuit).
6. cooldown/reauth candidates are skipped: put `b` in cooldown via
   `recordCodexUpstreamOutcome(config, "b", 429, ...)`, add usable `c`,
   all-unknown. Rotation target is `c`, not `b`.

## Risks / non-goals

- Non-goal: do not touch `pickLowestUsageCodexAccount` (src/codex-routing.ts:244)
  or the 429/failover paths; they already rotate.
- Non-goal: thread-affinity re-eval (the reuse branch returning before
  auto-switch, src/codex-routing.ts:312-318) is Phase 40.
- Risk: round-robin among unknowns can thrash if usage stays unknown across
  requests. Mitigated by thread affinity pinning a live thread after selection
  (src/codex-routing.ts:342) and by Phase 20 priming removing the unknown state.
- Risk: log volume. The `console.warn` fires only on the over-threshold +
  all-unknown path, rare once priming lands; acceptable as a diagnostic.

## Verification gate

- `bun x tsc --noEmit` -> exit 0.
- `bun test tests/codex-routing.test.ts` -> new cases pass, existing pass.
- `bun run privacy:scan` -> clean (warn strings log only account ids and the
  threshold, no emails or tokens).
