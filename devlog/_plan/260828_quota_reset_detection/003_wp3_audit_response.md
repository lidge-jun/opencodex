# wp3 A-gate audit response

A third grok-4.6 reviewer (`review-wp3-observation-wiring`) went silent through four bounded
wait cycles and was retired under DISPATCH-RETIRE-01. Two of three dispatched reviewers have
now failed this way — one on provider capacity, two on silence — so the audits below were run
directly. Recording that rather than implying a reviewer signed off.

## 1. Does the provider seam actually fire? — PROVEN YES

This is the question that killed the original design, so it gets a live probe rather than a
reading. Two consecutive committed reports for one anthropic account, driven through the same
calls `notifyProviderQuotaSnapshot` makes:

```
after report1 hits: 0
after report2 hits: 1 kinds: scheduled:5h
payload: {"kind":"scheduled","scope":"anthropic","accountTag":"1aw4hwbh","window":"5h",
          "percentBefore":94,"percentAfter":3,"previousResetAt":...,"resetAt":...,
          "detectedAt":...,"key":"anthropic|1aw4hwbh|5h|..."}
after report3 hits (idempotent): 1
```

First report is a baseline and fires nothing. The second is detected. A third identical
observation does not re-notify. The cache-key rotation that made the old design dead is now
irrelevant, because the baseline comes from the persisted swap map rather than
`cache.key === key`.

The payload contains only closed-union labels and numbers — no account id, no email, no path.

## 2. Lazy-import contract — VERIFIED

`rg` for a static `import ... from ".../quota/reset-"` in `src/codex/quota.ts` and
`src/providers/quota.ts` returns nothing; only the two dynamic `import()` calls exist
(`src/codex/quota.ts:359`, `:362`; `src/providers/quota.ts:2281`, `:2284`). None of the
four protected entrypoints names `quota/reset-` at all.

Residual, stated rather than fixed: because the seams do not await, observation order for two
writes in quick succession is promise-resolution order. Both compute the same idempotence key
for the same new deadline, so the claim ledger collapses them to one notification; the only
consequence is which one defines the baseline. wp5's guard will make the no-static-edge half
of this enforceable instead of grep-verified.

## 3. Found by me: the generation-cached enable gate was stale by construction — FIXED

The wp2 audit told me to cache the enable check against `captureConfigGeneration()`, and I
did. That was wrong, and I caught it while verifying the reviewer's fourth question myself.

`configGeneration` is only assigned at `src/lib/state-store-sweeper.ts:149`, inside
`reconcileStateGeneration`, which runs from `reconcileLiveStateStores` on account and
provider changes. Editing `quotaResetNotify` alone never bumps it. So enabling the feature
would have had NO effect until some unrelated account edit happened to reconcile — the exact
"toggling enabled takes effect on the next tick" property the doc claimed.

Now keyed on the config file's mtime and size, with a 5-second TTL bounding how often the hot
path stats. A config edit is picked up within 5 seconds; a quiet install pays one `statSync`
per 5 seconds rather than a full `safeParse` per request.

Worth naming the pattern: a cache key that does not actually change when the cached input
changes is worse than no cache, because it converts a performance concern into a correctness
bug that only shows up as "the feature does nothing".

## 4. Detector regressions since the last review — checked for missed REAL resets

The tightened rules could in principle suppress a genuine reset. Cases checked:

- rolling 5h window that genuinely resets: usage falls, so the drop carries it. Fires.
- weekly window at 0% on both sides past its deadline: no drop, but upstream issues a new
  deadline, so the corroboration branch fires.
- account that resets while completely unused with NO new deadline: returns null. This is a
  deliberate false negative — the snapshot is byte-identical to a carried-forward one, and
  there is no way to tell them apart. Recorded as a known limitation.
- rollover immediately followed by heavy use (3% -> 24% past the deadline): returns null via
  the rise check. Also deliberate; also recorded.

## 5. Test honesty

`settle()` in `tests/quota-reset-observation.test.ts` drains microtasks then waits 5 ms,
which is a race in principle. It is load-bearing only for the two seam tests, and the
observer-contract tests call `observeQuotaSnapshot` synchronously and assert its return
value, so the same behavior is covered without any timing dependency. If CI ever flakes here,
the fix is to assert the synchronous return rather than to raise the sleep.

Two assertions were weak and are now real: the account-tag test asserts the salt actually
changes the tag across installs (it previously only checked length and the absence of "@",
which any digest satisfies), and the claim-durability test now spawns a real second process
instead of calling a test-only flush.

VERDICT (direct audit): GO-WITH-FIXES (blockers=1) — the stale enable gate, fixed above.
