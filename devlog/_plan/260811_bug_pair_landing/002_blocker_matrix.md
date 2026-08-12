# 002 — Blocker matrix

What must be true before each pair lands. "Ours" marks a defect this session's
audit found that no reviewer had filed.

| WP | PR | Blocker | Source | Class |
|---|---|---|---|---|
| wp1 | #1460 | utf8 string compare instead of byte compare | reviewer | correctness |
| wp2 | #1462 | delete-vs-live-edit still resurrects a deleted provider/model | **ours** | correctness |
| wp3 | #1465 | rollback deletes by task name without proving this attempt created it | **ours** | correctness |
| wp4 | #1461 | none in the diff; red CI is infrastructure noise | — | verify-only |
| wp5 | #1452 | catch-all fallback substitutes a fixed System32 PowerShell for any resolver failure | reviewer | trust boundary |
| wp6 | #1434 | flush budget exhaustion resolves instead of rejecting | reviewer | durability |
| wp6 | #1434 | snapshot cap ignores document framing bytes | reviewer | correctness |
| wp7 | #1441 | see 070 (three open blockers) | reviewer | see 070 |

## wp4's red CI, classified

CI run `31466547693`, logs fetched with `gh run view --log-failed`:

- `test 2/4` — Bun 1.3.14 `panic: Segmentation fault at address 0xFFFFFFFFFFFFFFF8`
  after two passing `storage-worker-lifecycle` tests, exit 132. No assertion
  failed. Runtime crash, not a test failure.
- `test 3/4` — entered `tests/cli-models.test.ts`, went silent for ~14m44s,
  cancelled at the 15-minute cap. This is exactly the shape #1302 documents.
- `macos` — `Cursor blob ID key channel bounds > key bytes stay bounded at the
  4096-entry ceiling` timed out after 10000ms. The PR does not touch that test;
  it runs in ~170ms locally on both heads.
- `ci` — aggregate, red only because the above did not pass.

All three reproduced green locally on the PR head, on clean `dev`, and on the
PR merged onto current `dev` (73 pass / 0 fail across the three CI-associated
files). So wp4 is a verify-and-land, not a repair.

That is worth stating plainly because the tempting read of a red PR is "the
contributor broke something." Here the contributor broke nothing, and the
red is our own CI's two known ailments (#1302 shard hangs, Bun native crashes)
plus one timing-sensitive macOS assertion.

## Why two green PRs still need work

#1462 and #1465 arrived with no review and green checks. Both are wrong in a
way their own tests cannot see:

- #1462 fixes stale-write resurrection for rows that were *untouched* in
  memory. A probe at its exact head deleted a provider and a custom model on
  disk while editing those same rows in memory, and got
  `{"providerResurrected":true,"customModelResurrected":true}`. The
  delete-vs-edit case walks into `src/config.ts:2884-2896`, where a persisted
  `MISSING_CONFIG_VALUE` is not a plain record, so recursion is skipped and
  `live` wins — which is precisely the resurrection #1273 reports.
- #1465 gets the two-phase ordering right (verified: no manager stop, no
  canonical asset write, no routing mutation, no state publication in phase 1),
  but its rollback deletes the scheduler task by name at
  `src/service.ts:1002-1013`, and the absence probe at `2976-2981` is not atomic
  with the fixed-name `/create /f`. A concurrent registration can be deleted
  without this attempt ever proving ownership — which contradicts the PR's own
  stated invariant.
