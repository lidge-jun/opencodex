# 010 — Phase 1: PR #526 final rerun and merge

## MODIFY / NEW / DELETE map

Expected code delta: no new source changes beyond rebasing existing PR #526
commits, except one direct test-contract repair accepted by A-gate.

Existing PR #526 commits to preserve:

- `fix(codex): report whether a sync actually wrote the catalog or cache`
- `test(codex): cover real catalog sync write signals`

Additional allowed repair:

- MODIFY `tests/injection-model-api.test.ts`
  - Existing mock return:
    `return { added: 0, path: join(tempHome!, "missing-catalog.json"), catalogWritten: false };`
  - Required mock return:
    `return { added: 0, path: join(tempHome!, "missing-catalog.json"), catalogWritten: false, comboOmissions: [] };`
  - Rationale: `syncCatalogModels` now returns a structure whose refresh result
    contract includes `comboOmissions`; tests are outside `tsconfig.json`, so
    `bun x tsc --noEmit` does not detect this mock drift.

Branch operation:

- In `/Users/jun/.codex/worktrees/260727-pr526/opencodex`, fetch `origin/dev`.
- Rebase `codex/catalog-written-signal` onto current `origin/dev`.
- If conflict-free, run local verification.
- Push with `--force-with-lease` only after local verification.
- Wait for latest hosted checks on PR #526.
- Immediately before merge, re-fetch `origin/dev` and re-read PR #526. Squash
  merge PR #526 with branch deletion disabled if and only if:
  - PR head equals the pushed rebased SHA.
  - `origin/dev` equals the exact SHA used as the rebase base.
  - every check attached to that head is completed successfully.
  - `mergeable` is `MERGEABLE` and `mergeStateStatus` is `CLEAN`.
- If any stale-base condition fails, restart from fetch/rebase/local tests/push
  and hosted checks.

## TESTS

- `tests/codex-refresh.test.ts`
- `tests/codex-sync-api.test.ts`
- `tests/injection-model-api.test.ts`

These are the PR #526 affected tests from WP1 and cover:

- real filesystem catalog write signal;
- cache invalidation success/failure signals;
- sync API and injection-model API compatibility around the new booleans.

## Verification (C)

- `bun test tests/codex-refresh.test.ts tests/codex-sync-api.test.ts tests/injection-model-api.test.ts`
  exits 0.
- `bun x tsc --noEmit` exits 0.
- `git diff --check origin/dev` exits 0.
- `gh pr view 526 --json headRefOid,baseRefOid,mergeStateStatus,statusCheckRollup`
  shows the pushed head and no failed/pending checks before merge.
- `git rev-parse origin/dev` still equals the rebase base SHA immediately before
  merge.
- `gh pr view 526 --json mergeable,mergeStateStatus` reports `MERGEABLE` and
  `CLEAN` immediately before merge.
- After merge, `gh pr view 526 --json state,mergedAt,mergeCommit` shows merged
  commit on `dev`.
