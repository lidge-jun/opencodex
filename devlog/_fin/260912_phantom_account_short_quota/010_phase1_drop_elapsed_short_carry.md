# Phase 1: expire display carry without losing policy or notification evidence

## Final implementation

- `src/codex/quota.ts`: `assignCarriedShort` drops expired omitted short tuples only for
  display/rotation merges; credits-only and legacy `updateAccountQuota` use the same rule.
  `policyEvidence` preserves the previous short tuple, including its observation clock.
  Explicit incoming short readings retain the original merge semantics.
- `src/codex/routing.ts`: shares `resetAtToMs` with the carry expiry comparison.
- `src/quota/reset-observer.ts` and `src/quota/reset-seen-store.ts`: Codex-only opt-in retains
  absent short history for reset detection without manufacturing an incoming observation.
  Its original timestamp survives repeated partial updates and persistence. Explicit clear
  still removes the baseline; provider replacement behavior is unchanged.
- Structure owners document the cache contract and link to its canonical statement.

## Regression coverage

- Parser parity: Spark and WHAM weekly refresh remove stale display short fields; weekly-only,
  credits-only, future resets, explicit incoming resets, and legacy updates in seconds/ms.
- Main hard-lock policy: expired short 99 remains blocked across credits-only, weekly-only,
  and short metadata-only updates. A fresh short zero releases the block.
- Reset observation: two partial writes after expiry emit nothing, the next real short
  rollover emits exactly one scheduled notification, and explicit clear removes the baseline.
- Reset store: retained observation time survives persistence; non-opted-in writers still
  replace omitted windows.

## Audit corrections

Independent inherited-model reviewers found two regressions in the earlier patch: display
expiry leaked into the main-policy cache, and dropping display short fields also discarded
notification history. Both are corrected in the final implementation above.

No red run, local suite, typecheck, build, or install was executed. Remote CI must verify the
final pushed head; static comparison alone is not a passing execution result.
