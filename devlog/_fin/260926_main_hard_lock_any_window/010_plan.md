# 010 — Main-account 98% hard lock: any governing window blocks

## Problem
`getMainAccountHardLockStatus` (src/codex/main-account-hard-lock.ts) selects ONE window: 5h when any
5h field exists, else weekly, else monthly. A weekly reading of 98–100% with a 5h reading below 98 is
reported `ready`, so ocx keeps admitting main-account traffic until the weekly window is drained.

## Required policy (user, 2026-09-26)
- 5h >= 98 blocks, regardless of weekly.
- weekly >= 98 blocks immediately, even when 5h < 98.
- Either alone is sufficient.

## Diff-level plan
1. src/codex/main-account-hard-lock.ts
   - Governing windows = [short] if present + [weekly] if present; monthly only when neither exists
     (monthly-only accounts, unchanged; supplementary monthly still never governs).
   - Classify each window: blocked (finite, 0..100, >= 98), ready (finite, 0..<98), unknown (missing/invalid).
   - Any blocked -> blocked. resetAt = latest future reset among blocking windows; omitted when any
     blocking window lacks a future reset (lock lasts until EVERY blocking window reads lower).
   - Else any unknown -> unknown (admits, as today). Else ready.
   - An invalid/unknown 5h reading can no longer mask a valid blocking weekly reading.
2. src/codex/quota.ts mergeAccountQuota: policy-mode guard symmetric to preserveKnownShort — an
   observation with weeklyResetAt but no weeklyPercent keeps a retained blocking weekly tuple.
3. Tests (flip intended pins, add the user's cases):
   - main-account-hard-lock-policy.test.ts: replace "5h wins", "expired 5h no fallback", "5h shape stays
     unknown" with any-window cases: 5h97+w98 blocked, 5h98+w50 blocked, 5h97+w97 ready, release requires both,
     5h-unknown+w99 blocked, 5h-unknown+w20 unknown, resetAt = latest; reset test line 70 now needs weekly 0.
   - main-quota-evidence-validation.test.ts: "short zero keeps priority over weekly99" -> weekly99 blocks;
     "rejected short usage" -> blocked.
   - main-quota-window-observation.test.ts: weekly99 samples -> blocked, metadata-only -> unknown.
   - weekly reset-only policy observation keeps weekly block (new).
4. Copy: gui/src/i18n/*.ts codexAuth.mainHardLockDesc (10 locales), docs-site en+ko providers-accounts,
   structure/providers/openai-tiers.md paragraph.

## Out of scope
Monthly as an extra OR term for weekly/5h accounts; routing score; recovery probe cadence.

## Verification
Focused: the three hard-lock/quota test files + main-account-hard-lock-*.test.ts + account-usability/auth tests;
bun run typecheck; bun run structure:check; bun run test:changed; lint for gui i18n via typecheck.


## Audit fold (DeepSeek, NEAR-PASS)
- Folded: the governing window list is never empty — with no 5h/weekly the monthly slot is classified
  even if absent, so a reading-less record stays unknown.
- Folded: the weekly reset-only guard excludes monthlyIsPrimaryWindow observations so monthly-primary
  replacement still releases a weekly block.
- Folded: main-quota-window-observation weekly99 cases (incl. metadata-only, and final ready at 323/375)
  flip to blocked because weekly99 is retained; test expectations follow the rule, not the old pins.
- Rebutted/residual: weekly evidence has no freshness clock. Unchanged from today's weekly-only accounts;
  the per-minute blocked recovery sweep fetches WHAM, which carries the secondary window.
