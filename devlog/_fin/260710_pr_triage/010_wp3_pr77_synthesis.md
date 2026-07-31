# WP3 — PR #77 review synthesis (REVIEW-SYNTHESIS-01)

Reviewer: gpt-5.6-sol (Pascal), adversarial pre-merge review. VERDICT: FAIL (blockers=3).

## Per-blocker RCA + disposition
1. High — unbounded auto-retry (PR-head `gui/src/pages/Dashboard.tsx:320-332`). `updateRetryRef.current = 0` runs on every 200 response before retry evaluation, so `latest_unavailable` resets the cap each round: infinite 800ms retries; timers survive dialog close; StrictMode double-schedules from an impure updater. ACCEPT — fix in follow-up commit (counter must persist across latest_unavailable responses; reset only on success/manual retry/channel change).
2. High — sync busy-wait backoff (`src/update/index.ts:64-79` PR-head). `while (Date.now() < until) {}` + spawnSync x3 blocks the shared Bun.serve event loop up to ~37.5s. ACCEPT — follow-up commit must make retry async or move retry ownership to the GUI.
3. Med — timer/request races (no timer id retention; Retry enabled during backoff; stale `latest` timer can overwrite a `preview` result). ACCEPT — epoch guard + timer cleanup in follow-up.

Residual (non-blocking): ko/zh map `dash.updateRetry` to English "Retry" — cosmetic, translate in follow-up; de already has "Wiederholen" from #79.

## Cross-blocker conflict check
Blockers 1+3 are the same mechanism (client retry lifecycle) — one coherent Dashboard.tsx rework. Blocker 2 is server-side and independent. No conflicting fixes.

## Decision (user bias: integrate, not reject)
Merge #77 as-is (CI green, UX intent good), then land a single repair commit on main authored from Anscombe's (sol worker) patch design fixing 1-3, then re-audit the combined result with the SAME reviewer lane before C. The PR contributor keeps authorship of the feature; the repair commit references the review findings.
