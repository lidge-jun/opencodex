# Frontier benchmark snapshots

Static leaderboard data for the GUI **Frontier** page lives in
[`frontier-benchmarks.json`](./frontier-benchmarks.json).

These numbers are **snapshots**, not live OpenCodex metering. Refresh them when
upstream boards move, then bump `provenance.capturedAt` and (if needed) the
catalog `version`.

## Refresh checklist

1. Open each board’s `provenance.url` (prefer the page that publishes $/task when
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
   `gui/src/i18n/{en,de,ko,zh}.ts` (title, axis labels, source note).
6. Run `bun test tests/frontier-rank.test.ts` (from repo root) and a quick GUI
   pass on `#frontier` (By value only on uniformly measured boards).

## ProgramBench note

Costs for Program Bench must come from the
[extended leaderboard](https://programbench.com/extended/) (average API $/task),
not guessed from the compact main table.
