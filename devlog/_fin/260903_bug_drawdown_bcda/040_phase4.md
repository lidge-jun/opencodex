# 040 — Phase 4 (wp4): PR #3270 — incremental usage ledger aggregation

## Item

`fix(usage): aggregate complete ledger incrementally`, head
`f5aaf12071043bb1adaaf75217d62b53145d74ef`, base `ee24bab40004f4e3698636cba64f5bb6d18438fd`, 3535 additions /
1287 deletions across 21 files, label `bug` (+ `gui-screenshot-waived`, see below).

## Phase class: ADOPTION of a large diff

Per-file incoming change map, grouped:

New modules — `src/usage/ledger-scanner.ts` (+448), 
`src/server/management/usage-aggregate-cache.ts` (+464).
Rewritten core — `src/usage/summary.ts` (+915 / -655),
`src/server/management/api-key-usage.ts` (+97 / -43),
`src/server/management/logs-usage-routes.ts` (+64 / -87).
Wiring — `src/config.ts` (+3/-1), `src/types/config.ts` (+4/-1),
`src/lib/app-owned-memory-stores.ts` (+27/-8),
`src/server/management/usage-summary-cache.ts` (+4), `src/usage/log.ts` (+1/-1).
GUI — `gui/src/pages/use-dashboard-data.ts` (+1/-1) and
`gui/tests/dashboard-contracts.test.ts` (+1/-1): a single dashboard refresh
constant, nothing visual.
Docs — `docs-site/src/content/docs/reference/management-api.md` (+20/-1),
`structure/05_gui-and-management-api.md` (+33/-12).
Tests — `tests/usage-ledger-scanner.test.ts` (+498),
`tests/usage-summary.test.ts` (+311), `tests/usage-aggregate-cache.test.ts` (+301),
`tests/api-usage.test.ts` (+202/-473), `tests/api-key-attribution.test.ts` (+135/-3),
plus two-line touches to `tests/memory-watchdog.test.ts` and
`tests/settings-stream-mode.test.ts`. 1447 added test lines.

## Gate analysis

`enforce-target` failed with `PR quality gate failed: missing UI screenshot` (run
33660610072). The gate triggers on any `gui/` path, but the entire GUI delta here
is one refresh-interval constant and its contract test — there is no UI change to
screenshot. This is the false positive that `gui-screenshot-waived` exists for. Its
authority is the enforcement workflow itself: `GUI_SCREENSHOT_WAIVER_LABEL` is
declared at `.github/workflows/enforce-pr-target.yml:259`, matched against the
PR labels at `:678`, and removes the screenshot failure from `failures` at
`:727-730`. `AGENTS.md` does not mention the label; the workflow is the only
authority, and PR #2805 carries the same label as precedent. The label was
applied rather than demanding a screenshot of a one-constant change.

## TESTS — the assertion that is RED before the fix (corrected)

The earlier draft claimed incremental-equals-full-recompute as the red
assertion. That is not red: the pre-fix implementation recomputes wholesale, so
it satisfies that equality trivially. The actual defect, per the PR title and
CodeRabbit's summary, is COMPLETENESS — the pre-fix aggregation is bounded by
read and row limits, so earlier history is silently omitted from usage reports.

The red assertion is therefore: build a ledger larger than the pre-fix read/row
bound, request the usage summary, and assert the reported totals include the
oldest rows. On the pre-fix tree the early rows are missing and the totals come
back short. `tests/usage-ledger-scanner.test.ts` and `tests/usage-summary.test.ts`
are the files carrying that case; `tests/api-key-attribution.test.ts` carries the
per-key equivalent. Locally, only those files may be run.

## Verification (C)

```
gh pr view 3270 --json headRefOid,statusCheckRollup
gh run view <run-id> --log-failed      # when any check is red
git fetch origin dev && git merge-base --is-ancestor <merge-sha> FETCH_HEAD
```

Merge requires the green exact-head matrix AND a read confirming the new scanner
still reads a ledger written by the old aggregator. Otherwise the outcome is
BLOCKED or NEEDS_HUMAN with the concrete reason.

