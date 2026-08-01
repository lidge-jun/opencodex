# Issue #82 HY3 Catalog Guard — Completion Record

## Outcome

- Published commit: `4ccc6da687dc50ba3782cd6cef6f23d89918856e`
  (`fix(opencode-go): hide unavailable hy3 from catalogs (#82)`) on `origin/dev`.
- GitHub issue: `https://github.com/lidge-jun/opencodex/issues/82`, closed as
  completed on 2026-07-10 after a corrective reply.
- Corrective reply:
  `https://github.com/lidge-jun/opencodex/issues/82#issuecomment-4933180996`.
- Release status was stated accurately: the complete fix is on `dev`, not v2.7.4,
  and is intended for the next release.

## Delivered behavior

- `src/codex/catalog.ts` owns one exact compatibility exclusion for
  `opencode-go/hy3-preview`.
- The exclusion runs after live/static/jawcode aggregation, so the public Zen Go
  `/models` row cannot enter dashboard or Codex model lists.
- The same policy runs after both on-disk routed-entry preservation branches, so an
  older catalog cannot resurrect HY3 during an empty refresh or absent-provider sync.
- Direct manual routing, future OpenCode Go ids, and `hy3-preview` under unrelated
  providers remain unchanged.
- `structure/03_catalog-and-subagents.md` records the general catalog policy.

## Activation and verification evidence

| Gate | Evidence |
| --- | --- |
| Live path red | Focused test failed before the guard because the result contained `opencode-go/hy3-preview` (exit 1). |
| Live path green | `bun test tests/provider-live-models.test.ts --test-name-pattern 'HY3 compatibility'`: 1 pass, exit 0. |
| Disk preservation red | Focused test failed before the sync fix because the warning reported 3 preserved rows (exit 1). |
| Disk preservation green | `bun test tests/codex-catalog-sync-hardening.test.ts --test-name-pattern 'compatibility-excluded'`: 1 pass, exit 0. |
| Affected tests | Five catalog suites: 68 pass, 0 fail. |
| Typecheck | `bun run typecheck`: exit 0. |
| Diff hygiene | `git diff --check`: exit 0. |
| Full workspace | `bun test ./tests/`: 1,943 pass, 0 fail, 8,290 assertions. |
| Independent review | First C review found the on-disk resurrection gap; after the fix and new fired-path test, the same reviewer returned `VERDICT: PASS`. |

## Publication isolation

- Cached diff contained exactly four paths: the two catalog-policy hunks in
  `src/codex/catalog.ts`, two regression test files, and the catalog SOT.
- The unrelated dated-alias/warning hunks remained unstaged in
  `src/codex/catalog.ts` after partial staging.
- Concurrent README, Images proxy, server, structure, and test changes remained
  unstaged and were not included in commit `4ccc6da6`.

## Pessimist / removal signal

The guard becomes wrong if Console Go begins accepting `hy3-preview` consistently.
Remove the exact set entry only after authenticated inference succeeds and the provider's
documented lite lineup agrees with its public `/models` catalog. A public catalog row by
itself is insufficient because that mismatch caused this defect.

## Pending work

No work remains for issue #82. Publishing a release from `dev` is a separate release
workflow and was not expanded into this fix.

