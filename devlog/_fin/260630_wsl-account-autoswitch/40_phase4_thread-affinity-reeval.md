# 40 - Phase 4: Thread-affinity re-eval

Purpose: a bound thread that crosses the quota threshold mid-session never
auto-switches, because the affinity reuse branch returns before
`applyQuotaAutoSwitch` runs. This is root-cause #3 in the MOC. Re-run the quota
check for a bound thread, but only when it can actually change the outcome, so
affinity does not thrash.

## The gap (confirmed in code)

In `resolveCodexAccountForThreadDetailed` (src/codex-routing.ts:301-343) the
bound-thread reuse branch is:

```ts
if (threadId && threadAccountMap.has(threadId)) {
  const entry = threadAccountMap.get(threadId)!;
  if (isThreadAffinityExpired(entry, now)) { ... return { status: "expired", ... }; }
  if (
    isThreadAffinityGenerationLive(entry)
    && isCodexAccountSelectable(config, entry.accountId, now)   // src/codex-routing.ts:313-315
  ) {
    entry.lastUsedAt = now;                                     // :316
    return { status: "selected", accountId: entry.accountId };  // :317  <-- EARLY RETURN
  }
  threadAccountMap.delete(threadId);
}
```

The early return at src/codex-routing.ts:317 fires before
`applyQuotaAutoSwitch` (src/codex-routing.ts:334), as long as the bound account
stays selectable. `isCodexAccountSelectable` only checks cooldown + usability
(src/codex-routing.ts:159-161); it does not look at the
`autoSwitchThreshold` quota score. So:

- `entry.lastUsedAt = now` (line 316) slides the idle window forward on every
  reuse, and `isThreadAffinityExpired` is `now - lastUsedAt > 24h`
  (src/codex-routing.ts:164-166, `CODEX_THREAD_AFFINITY_IDLE_TTL_MS`,
  src/codex-routing.ts:33). A continuously active thread never expires.
- Auto-switch only re-triggers for that thread when the bound account becomes
  *unselectable* (cooldown / unusable / needs-reauth -> falls past line 318 to
  `threadAccountMap.delete`), or when `clearThreadAccountMapForAccount`
  (src/codex-routing.ts:55-59) drops the binding on a quota/credential outcome
  (called from the 429/401 handlers around src/codex-routing.ts:371, :382).

Net: a single long-lived thread can sit pinned to an account that is over
threshold for up to 24h while a cooler pool account is available, and never
re-evaluate. That is exactly the WSL user's "automatic switch never happens"
report when manual switching works fine.

## Fix design

Re-run the threshold check inside the reuse branch, but gate it so we do not
re-shuffle affinity on every request.

Rule: rebind a bound thread only when both hold.

1. The bound account is at/over `autoSwitchThreshold`
   (`config.autoSwitchThreshold ?? 80`, mirroring src/codex-routing.ts:264),
   computed with `computeCodexUsageScore(getAccountQuota(boundId),
   getPoolAccountPlan(config, boundId))` - the same scoring used by
   `applyQuotaAutoSwitch` (src/codex-routing.ts:266-267).
2. A strictly-better candidate exists: `pickLowerUsageAccount(config, boundId,
   boundUsage, now)` returns an id `!== boundId` (src/codex-routing.ts:231-242).
   The strict `<` there means an all-unknown pool will not trigger a rebind, so
   this rides on the Phase 10 deadlock fix rather than re-introducing churn.

Anti-thrash cadence: only run this re-eval at most once per
`REEVAL_INTERVAL_MS` per thread (proposal: 60_000 ms, well under the 5h/weekly
quota windows but enough to stop per-request flapping). Store `lastReevalAt` on
`ThreadAffinityEntry` (src/codex-routing.ts:10-15). Between intervals the branch
keeps the existing fast path (reuse + slide `lastUsedAt`). Because rebind only
happens when a *strictly lower* account exists and the bound one is over
threshold, two requests cannot ping-pong: after a rebind the new account is the
lowest, so condition 2 fails on the next interval.

## Exact branch change

MODIFY `src/codex-routing.ts`

Add to `ThreadAffinityEntry` (src/codex-routing.ts:10-15):

```ts
lastReevalAt: number;
```

Set it in `bindThreadAffinity` (src/codex-routing.ts:193-206) alongside
`lastUsedAt: now` so a fresh/rebound entry starts its interval clock at `now`.

Rewrite the reuse success block (src/codex-routing.ts:313-318):

```ts
if (
  isThreadAffinityGenerationLive(entry)
  && isCodexAccountSelectable(config, entry.accountId, now)
) {
  entry.lastUsedAt = now;
  // Periodic quota re-eval: a long-lived bound thread must still switch when it
  // crosses autoSwitchThreshold and a strictly-cooler account exists.
  if (now - entry.lastReevalAt >= REEVAL_INTERVAL_MS) {
    entry.lastReevalAt = now;
    const threshold = config.autoSwitchThreshold ?? 80;
    if (threshold > 0) {
      const usage = computeCodexUsageScore(
        getAccountQuota(entry.accountId),
        getPoolAccountPlan(config, entry.accountId),
      );
      if (usage >= threshold) {
        const best = pickLowerUsageAccount(config, entry.accountId, usage, now);
        if (best !== entry.accountId) {
          setActiveCodexAccount(config, best);
          bindThreadAffinity(threadId, best, now);  // rebinds + resets clocks
          return { status: "selected", accountId: best };
        }
      }
    }
  }
  return { status: "selected", accountId: entry.accountId };
}
```

Notes:
- `computeCodexUsageScore`, `getAccountQuota`, `getPoolAccountPlan`,
  `pickLowerUsageAccount`, `setActiveCodexAccount` are all already in this
  module (src/codex-routing.ts:5, :228-229, :208-211, :231, :255). No new
  imports.
- Keep `entry.lastUsedAt = now` first so the idle TTL still slides even when the
  re-eval interval has not elapsed.
- This reuses `applyQuotaAutoSwitch`'s exact threshold + strict-`<` semantics
  rather than inventing a second policy, so bound and unbound paths agree.

## Interaction with bindThreadAffinity

`bindThreadAffinity` (src/codex-routing.ts:193-206) already overwrites the map
entry and resets `createdAt`/`lastUsedAt`; add `lastReevalAt: now`. Calling it
from the rebind path replaces the binding *and* resets the re-eval clock for the
new account, so the next interval starts clean. It also re-validates the target
via `readCodexAccountRecord` (src/codex-routing.ts:194-195) - if the chosen
account lost its credential between selection and bind, the map simply is not
updated and the next request re-resolves from `activeCodexAccountId`.

`setActiveCodexAccount` (src/codex-routing.ts:255-259) persists the switch so
the bound-thread decision and the global active account stay consistent with
what the unbound path would have produced.

## Regression tests

MODIFY `tests/codex-routing.test.ts` (env isolation + helpers already present,
tests/codex-routing.test.ts:62-93)

- bound thread over threshold switches: bind `t1` to `a`
  (`resolveCodexAccountForThread("t1", config)`), set
  `updateAccountQuota("a", 90, ...)` and `updateAccountQuota("b", 5, ...)`,
  advance `now` past `REEVAL_INTERVAL_MS`, and assert the next resolve returns
  `"b"` and `config.activeCodexAccountId === "b"`.
- bound thread under threshold stays: bound to `a` at usage 50, `b` at 5;
  advance past the interval; assert it still returns `"a"` (under threshold ->
  no rebind even though `b` is lower).
- no flapping within interval: over-threshold `a`, lower `b`, but call again
  before `REEVAL_INTERVAL_MS` elapses; assert it stays `"a"` (interval gate),
  then switches once the interval passes, then a subsequent call stays on `b`
  (no ping-pong, since `b` is now the lowest).
- all-unknown pool does not flap: `a` and `b` both unknown (=100); even over the
  threshold, strict `<` in `pickLowerUsageAccount` yields no better candidate,
  so the thread stays on `a`.
- idle TTL unchanged: a reuse just under the interval still slides
  `lastUsedAt` (binding survives), guarding against an off-by-one in the new
  branch ordering.
- Typecheck: `bun x tsc --noEmit`.

## Risks

- Time source: tests and callers pass `now`; production uses `Date.now()`
  (src/codex-routing.ts:303). WSL clock skew after resume could make one
  interval check early/late, but the cadence is advisory, not correctness, so
  worst case is one delayed re-eval.
- Persisted switch on a read path: `setActiveCodexAccount` writes config
  (`saveConfig`, src/codex-routing.ts:257) from within resolution, same as the
  existing unbound auto-switch (src/codex-routing.ts:271). No new write cost
  versus today's unbound path; the interval gate bounds frequency.
- Quota must be primed for this to fire: if WHAM never populated (root-cause #2
  / Phase 20-30), the bound account stays `unknown=100` and strict `<` blocks
  rebind. This fix depends on Phases 10/20 landing to be observable.
- Failover parity: this branch intentionally re-evals quota only, not
  `applyFailureFailover` (src/codex-routing.ts:286-296); transient-failure
  failover for bound threads still flows through the unselectable/clear paths.
  Call out in review whether bound threads also need failure re-eval.

## Build record

- Pending implementation.
