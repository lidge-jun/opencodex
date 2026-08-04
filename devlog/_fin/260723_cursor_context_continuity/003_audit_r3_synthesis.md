# Audit round 3 synthesis (same reviewer, VERDICT: GO-WITH-FIXES, blockers=2)

| # | Sev | Decision | Resolution |
|---|-----|----------|------------|
| 1 | Med | ACCEPT | `markModelsFetchFailure` only records a timestamp (`model-cache.ts:28`); the skip happens only where `isModelsFetchCoolingDown` is consulted, and the existing check sits BELOW the cursor branch (`catalog.ts:1562`). Amendment: cursor branch gains its own `isModelsFetchCoolingDown(name)` guard after the fresh-cache check and before `fetchCursorUsableModels`, returning the same stale/configured degradation; failure path keeps `markModelsFetchFailure(name)`. 030 amended. |
| 2 | Med | ACCEPT | A fake CursorTransport bypasses the live-transport tracker, so "rekey observed" via the fake is unimplementable/tautological. Amendment: server E2E asserts rotation + persistence only; rekey invocation is covered at adapter level via a spy seam on `rekeyCursorContextUsage` (optional dep on createCursorAdapter deps, defaulting to the real function) — smallest honest seam. 010 amended. |
| minor | — | ACCEPT | 030 wording: integration smoke observes `LiveCursorTransport.run()` (async iterable); `createCursorAdapter.runTurn()` emits error events rather than throwing. |

Round history: r1 FAIL (8) → r2 FAIL (6) → r3 GO-WITH-FIXES (2, both folded).
Main-agent judgment: near-pass — all High blockers resolved by r3; the two
Medium residuals are folded as concrete doc amendments above. Exit A→B per
AUDIT-LOOP-01.
