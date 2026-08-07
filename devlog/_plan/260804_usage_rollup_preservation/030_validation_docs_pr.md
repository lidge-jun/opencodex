# 030 — Real-data validation, docs, PR

One PABCD cycle. Write scope: `docs-site/` usage/observability page(s),
`.tmp/` scratch for the production-copy validation, PR creation.

## Real-data validation (evidence for goalplan c4)

1. Copy `~/.opencodex/usage.jsonl` (157 MB, 380k rows) into a `mktemp -d`
   sandbox with `OPENCODEX_HOME` pointed at it.
2. Reference: full-raw parse via `readUsageEntries()` + `summarizeUsage(all)`
   in a bun script (no byte cap).
3. Candidate: run `foldUsagePrefix` to catch-up, then route-equivalent
   `readUsageSnapshotForManagement(64 MiB, cutline)` + merge.
4. Assert equality: summary totals, day grid, models, providers (cost to 1e-6).
5. Record timings: fold duration, post-fold read duration vs 157 MB full parse.

## docs-site

Update the usage/monitoring page: what `usage-rollup.jsonl` /
`usage-rollup-meta.json` are, that history is preserved past the 64 MiB read
window, day-grain nuance for 7d/30d, `usageRollupEnabled` flag, and that
deleting the rollup files is safe (they rebuild). Check translated locales for
contradictions per repo policy (update English; note locale sync if present).

## Gates before PR

- `bun run typecheck`
- `bun run test`
- `bun run privacy:scan`
- `bun run lint:gui` only if gui/ touched (it is not).

## PR

- Push `codex/260804-usage-rollup`; PR targets `dev`.
- Description: problem (production truncation incident 2026-08-04), design
  (offset cutline, delta segments, fold ordering, rebuildable cache), research
  provenance summary, test evidence, real-data validation numbers, flag,
  follow-ups (raw truncation policy deliberately out of scope).
