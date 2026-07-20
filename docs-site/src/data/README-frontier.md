# Frontier benchmark snapshots

Static leaderboard data for the docs-site **Benchmarks** page lives in
[`frontier-benchmarks.json`](./frontier-benchmarks.json), rendered by
`../components/FrontierBoards.astro`. Ported from PR #144 (GUI Frontier page
proposal) — the GUI was not the right home for hand-maintained snapshots.

These numbers are **snapshots**, not live OpenCodex metering. Refresh them when
upstream boards move, then bump `provenance.capturedAt` and (if needed) the
catalog `version`.

## Refresh checklist

1. Open each board's `provenance.url` (prefer the page that publishes $/task when
   you intend `costKind: "measured"`).
2. Update scores / costs / effort-or-harness labels row-by-row. Prefer the
   **extended** or methodology page when the landing table omits cost.
3. Set per-row `costKind`:
   - `measured` — published average cost-per-task from the source
   - `estimated` / `apiBlend` — illustrative, relative, or list-price blends
4. Keep `modeKind` honest:
   - `effort` — reasoning ladder (`low` / `high` / `xhigh` / …)
   - `harness` — agent scaffold id (`claude-code` / `codex` / …)
5. Sync localized board copy under `frontier.board.<id>.*` in
   `docs-site/src/data/frontier-i18n.ts` (title, axis labels, source note;
   en/ko/zh-cn).
6. Run `bun run build` in `docs-site/` and eyeball the Benchmarks page in all
   three locales (score/$ column only on uniformly measured boards).

## ProgramBench note

Costs for Program Bench must come from the
[extended leaderboard](https://programbench.com/extended/) (average API $/task),
not the landing table.
