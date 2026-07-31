# Phase 2 — Usage API and Logs Token Column

Phase 1 (commit `d1297d7`) added `src/usage-log.ts` and persisted reported usage to `~/.opencodex/usage.jsonl`. This phase exposes aggregate usage to the GUI and surfaces per-request tokens in the Logs table.

## Surface

### NEW `src/usage-summary.ts`

Pure module — no HTTP, no disk reads. Takes a `PersistedUsageEntry[]` (or array of the in-memory request log subset) and produces the `/api/usage` shape from `00_usage_accounting_plan.md`. Pure so it can be unit tested without touching the file system.

Exports:

- `summarizeUsage(entries: PersistedUsageEntry[], range, now): UsageSummary`
- `parseRange(input: string | null): "7d" | "30d" | "all"` (defaults to `"30d"`)

Range semantics:

- `7d` and `30d` filter on `entry.timestamp >= now - days*86400000`
- `all` keeps everything
- `summary.since` is the lower bound used (or `null` for `all`)

`summary.coverageRatio` = `reportedRequests / max(1, requests)`. Avoids divide-by-zero.

`days[]` is generated for every day in the range, even days with zero requests, so the GitHub-style heatmap has stable columns. Each day uses local-time `YYYY-MM-DD` keys (we treat the local TZ of the proxy, since that matches where the proxy owner reads the dashboard).

`models[]` is keyed by `(provider, model, resolvedModel)`. Sorted by `requests` desc.

`providers[]` is keyed by `provider`. Sorted by `requests` desc.

Missing usage stays distinct from zero. Aggregations of token counts ignore entries without a `usage` object — they only count toward `requests` and `unreportedRequests`.

### MODIFY `src/server.ts`

- Add `GET /api/usage` handler at the same route registration height as `/api/logs`.
- Source is `readUsageEntries()` from `usage-log.ts`. The in-memory `requestLog` is bounded to `MAX_LOG_SIZE`, so it would silently truncate the daily heatmap. The JSONL on disk is the durable source.
- Wrap reads in try/catch — on read error return `{ range, since: null, generatedAt: Date.now(), summary: {...zeroes...}, days: [], models: [], providers: [], error: "<safe-category>" }` rather than 500. Error string is a fixed category (`"read_failed"` or `"parse_failed"`), never raw error message.
- Reject queries with unknown range values by treating them as `30d` (no 400).
- Keep `/api/logs` unchanged. Existing `RequestLogEntry` already carries `usage` + `usageStatus` + `totalTokens` from Phase 1, so GUI Logs gets those fields for free.

### MODIFY `gui/src/pages/Logs.tsx`

- Add `usage`, `usageStatus`, `totalTokens` to `LogEntry`.
- Insert a `Tokens` column between `Status` and `Error`.
- Display: `formatTokens(totalTokens)` when `usageStatus === "reported"`; otherwise muted `unreported` or `unsupported` label. Never show `0` when usage is missing.
- `formatTokens(n)` returns `1.2K` for `>= 1000`, `42` for `< 1000`, `113.7K` for `113742`. Plain integer (no decimal) for `< 10000`.
- Title attribute exposes the full breakdown (`in=…, out=…, cached=…, reasoning=…`) so dense data is one-hover away.

### MODIFY i18n bundles (`gui/src/i18n/{en,ko,zh}.ts`)

- Add `logs.col.tokens`, `logs.tokens.unreported`, `logs.tokens.unsupported`, `logs.tokens.estimated`.
- Keep wording short for table density.

### NEW `tests/usage-summary.test.ts`

- `summarizeUsage` with mixed reported/unreported/unsupported across multiple days
  - confirms `summary` totals add up
  - confirms missing usage does not inflate token totals
  - confirms `days[]` covers the full range with zero-fill
  - confirms `coverageRatio` stays in `[0, 1]`
- `parseRange` accepts `7d`, `30d`, `all`, defaults to `30d` on `null`/unknown.

### MODIFY `tests/request-log.test.ts`

- Already updated in Phase 1 for new field. No further changes unless a regression appears.

### Optional: `tests/api-usage.test.ts`

- Light integration test of the HTTP handler, using `OPENCODEX_HOME` fixture + a hand-written `usage.jsonl` to assert response shape.

## Out Of Scope

- Usage GUI tab (Phase 3 in the slice map).
- Heatmap rendering (Phase 3).
- Dashboard summary card (Phase 4).
- Estimated tokens (`estimated` status stays a reserved enum value).

## Risks

- The daily heatmap range is computed in proxy local time. If the user's GUI is in a different TZ, days near midnight may shift. Acceptable for v1; documented as a known limitation.
- `usage.jsonl` is append-only and unbounded. The slice map already implies log rotation is a separate concern; not in scope for Phase 2.
- `usage-summary.ts` does no streaming. A pathological file (millions of lines) would be slow. Mitigation: the JSONL only grows on real requests; we can add streaming aggregation in a later phase if it ever matters.

## Verification

- `bun test tests/usage-summary.test.ts tests/usage-log.test.ts tests/request-log.test.ts`
- `bun x tsc --noEmit`
- `cd gui && bun run build`
- Atomic commits:
  - `feat(usage): add /api/usage aggregate endpoint`
  - `feat(gui): show token totals in Logs table`
