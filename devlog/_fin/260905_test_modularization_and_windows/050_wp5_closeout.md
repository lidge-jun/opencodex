# 050 - wp5: closeout

## Class call

C1 docs plus the final measurement.

## Steps

1. `041_shard_measurement.md`: five post-PR-7 `dev` runs, per-job table, mean wall.
2. `structure/00_overview.md` (or the nearest structure note naming `tests/`):
   one paragraph on the domain layout, `layout.json` as the map, and
   `tests/test-layout.test.ts` as the guard.
3. `docs-site/`: only if a contributor page quotes `bun test tests/<name>`
   (`rg -n 'bun test tests/' docs-site/src`); update the English source and
   leave locales unless they contradict it.
4. `scripts/test.ts:458` comment "Twenty-five files" -> live count from
   `rg -l 'from "[./]*/gui/src' tests | wc -l`.
5. Close the tracking issue with the list of merged PR SHAs and the
   before/after wall numbers.
6. `090_outcome.md`: terminal outcome, every PR with head SHA, run id,
   ancestry command output; `git mv devlog/_plan/260905_test_modularization_and_windows devlog/_fin/`
   as the last PR.

## Verification

`bun run privacy:scan`; `bun test tests/ci-workflows/repo-hygiene.test.ts`; exact-head CI on the docs PR.

