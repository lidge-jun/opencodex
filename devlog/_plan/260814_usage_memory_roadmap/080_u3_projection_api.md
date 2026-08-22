---
title: "U3: Projection-backed Usage API"
phase: "080"
depends: ["070"]
consumes: ["src/usage/usage-index.ts"]
branch: codex/u3-projection-api
---

# 080 — U3: Switch /api/usage to read from SQLite

## Thesis

The `/api/usage` endpoint currently parses a 64 MiB JSONL tail on every cold read.
After U2, it should read from the SQLite projection — O(1) for aggregates regardless
of file size, and warm queries are instant.

## Current state

- `src/server/management/logs-usage-routes.ts`: handles /api/usage
- Calls `readUsageSnapshotForManagement` → parses 64 MiB tail
- Passes entries to `summarizeUsage` for in-memory aggregation
- `usage-summary-cache.ts` caches the computed summary with TTL

## File change map

### MODIFY: src/server/management/logs-usage-routes.ts

Replace the read path:

```diff
- const { snapshot } = await readUsageSnapshotForManagement(maxReadBytes);
- const entries = snapshot.entries;
- const summary = summarizeUsage(entries, range, surface, now);
+ // Read from SQLite projection (U2)
+ const db = openUsageIndex(configDir);
+ // Ensure projection is up to date
+ projectIncrementally(db, readManifest(configDir).segments, configDir);
+
+ // Build summary from projection tables
+ const dailyRows = readDailyAggregates(db, rangeWindow.since, now);
+ const recentRows = readRecentRequests(db, 500);
+ const summary = buildSummaryFromProjection(dailyRows, recentRows, range, surface, now);
```

### NEW: src/usage/projection-summary.ts

Bridge between SQLite projection rows and the existing `UsageSummary` shape:

```ts
/**
 * Build a UsageSummary from SQLite projection rows.
 * Produces the same shape as the legacy summarizeUsage() so the
 * GUI and API consumers see no change.
 */
export function buildSummaryFromProjection(
  dailyRows: UsageDailyRow[],
  recentRows: UsageRequestRow[],
  range: UsageRange,
  surface: UsageSurface,
  now: number,
): UsageSummary;
```

### MODIFY: src/server/management/usage-summary-cache.ts

Update cache key to include projection generation:

```diff
+ // Cache key now includes projection checkpoint, not file revision
+ const projectionKey = \`${lastSegmentId}:${lastOffset}\`;
```

### NEW: tests/usage-projection-api.test.ts

Test cases:
1. /api/usage response from SQLite matches legacy parse for 7d range
2. /api/usage response from SQLite matches legacy parse for 30d range
3. Warm query time < 50ms regardless of segment count
4. Coverage metadata: shows projection status + retained range
5. All-time aggregate never decreases as segments rotate
6. New append → next /api/usage reflects it (incremental projection)
7. Projection rebuilding state shown in response metadata
8. Frontend contract: same JSON shape as before (backward compatible)

## Activation scenario

A user with 500k entries across 8 segments hits /api/usage. Instead of parsing
64 MiB of JSONL, the endpoint reads pre-computed aggregates from SQLite. The
response includes the same totals, models, providers, days, and accounts as
before, but cold read drops from ~25 seconds to <100ms.

## Scope boundary

IN: API route change, projection summary bridge, cache update, tests
OUT: Adding new API fields (P2), Today/Yesterday filtering (P2),
     GUI changes (P2), raw export (P2)
