---
title: "U2: Incremental SQLite projector"
phase: "070"
depends: ["060"]
consumes: ["src/usage/segments.ts"]
branch: codex/u2-sqlite-projector
---

# 070 — U2: Incremental SQLite projector

## Thesis

Build a SQLite index that aggregates usage data from JSONL segments. The index
is a projection — it can always be rebuilt from the segments. It replaces the
in-memory 64 MiB tail parse as the primary data source for summaries.

## Current state

- No SQLite in the usage subsystem
- `src/usage/summary.ts:700`: `summarizeUsage` builds all projections from
  a `PersistedUsageEntry[]` array in memory
- `src/server/management/usage-summary-cache.ts`: TTL cache over computed summaries
- Bun ships with built-in SQLite (`bun:sqlite`)

## File change map

### NEW: src/usage/usage-index.ts

```ts
import { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 1;
export const PROJECTOR_VERSION = 1;

/** Open or create the usage index database. */
export function openUsageIndex(configDir: string): Database;

/** Run full schema migration. */
export function migrateSchema(db: Database): void;

/** Tables:
 * - usage_projection_meta: schema_version, projector_version,
 *   last_indexed_segment, last_indexed_offset, segment_digest,
 *   last_indexed_at, rebuild_state
 * - usage_request_recent: requestId, startedAt, completedAt,
 *   surface, provider, model, status, token fields, duration,
 *   bounded diagnostic fields
 * - usage_daily: localDate, timezone, surface, provider, model,
 *   statusClass, requestCount, measuredCount, token accumulators,
 *   costAtCapture, duration/ttft accumulators
 * - usage_storage_manifest: segmentId, path, firstTs, lastTs,
 *   bytes, rows, sealed/projected/archived/deleted state
 */

export interface ProjectionCheckpoint {
  lastSegmentId: string;
  lastOffset: number;
  segmentDigest: string;
}

/**
 * Incrementally project new entries from segments into the index.
 * Reads from the checkpoint forward, deduplicates by requestId,
 * updates daily aggregates, and advances the checkpoint atomically.
 */
export function projectIncrementally(
  db: Database,
  segments: UsageSegment[],
  configDir: string,
): { rowsProcessed: number; segmentsProcessed: number };

/**
 * Full rebuild: drop and recreate all projection tables,
 * then project every retained segment from scratch.
 */
export function rebuildProjection(
  db: Database,
  segments: UsageSegment[],
  configDir: string,
): { rowsProcessed: number };

/**
 * Read daily aggregates for a date range.
 */
export function readDailyAggregates(
  db: Database,
  since: number | null,
  until: number,
): UsageDailyRow[];

/**
 * Read recent request details (bounded by row count).
 */
export function readRecentRequests(
  db: Database,
  limit: number,
): UsageRequestRow[];
```

### NEW: tests/usage-sqlite-projector.test.ts

Test cases:
1. Fresh projection from 3 segments → matches legacy full parse for tokens/requests/cost
2. Incremental: add entries to active segment → project incrementally → totals match
3. RequestId dedup: same requestId in two segments → counted once
4. Daily aggregates: correct date grouping in Asia/Seoul timezone
5. Model/provider breakdown matches legacy `summarizeUsage` output
6. Crash recovery: projection interrupted mid-segment → resumes from checkpoint
7. Full rebuild produces identical results to incremental
8. Schema migration from v0 (fresh) to v1
9. Malformed JSONL line → skipped with count, not crash
10. Empty segments handled gracefully

## Activation scenario

After U1 creates segments, the projector runs on startup (or on first
`/api/usage` request) and indexes all unsealed segments. Subsequent appends
trigger incremental projection. The SQLite file is a derived artifact — deleting
it and restarting rebuilds everything from segments.

## Scope boundary

IN: SQLite schema, projector logic, checkpoint, rebuild, tests
OUT: Changing `/api/usage` endpoint (080), retention/archive (P2), GUI
