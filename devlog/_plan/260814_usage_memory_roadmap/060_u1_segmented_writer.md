---
title: "U1: Segmented usage writer"
phase: "060"
depends: []
consumes: []
branch: codex/u1-segmented-writer
closes: "(new tracker, #1008 prior art)"
---

# 060 — U1: Segmented usage writer

## Thesis

Replace the single unbounded `usage.jsonl` with date/size-rotated segments.
Each segment is a self-contained JSONL file. The active segment receives appends;
sealed segments are immutable. Migration from the existing single file is automatic.

## Current state

- `src/usage/log.ts:432`: `appendUsageEntry` → `appendFileSync` to single file
- `src/usage/log.ts:147`: `usageLogPath` returns `${configDir}/usage.jsonl`
- `src/usage/log.ts:425`: `ensureUsageLogDir` creates the parent directory
- No rotation, no segment concept, no manifest
- `src/usage/log.ts:439`: `UsageLogRevision` tracks inode+size+mtime for cache invalidation
- Reader (`readUsageSnapshotForManagement`) reads a 64 MiB tail from the single file

## File change map

### NEW: src/usage/segments.ts

Core segment management module:

```ts
/** Segment naming: usage-YYYY-MM-DD-NNNN.jsonl[.active] */
export interface UsageSegment {
  id: string;           // e.g. "usage-2026-08-14-0001"
  path: string;         // full path
  active: boolean;      // true = receives appends
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  bytes: number;
  rows: number;
  sealedAt: number | null;
}

export interface UsageSegmentManifest {
  version: 1;
  segments: UsageSegment[];
  activeSegmentId: string | null;
  migratedFromLegacy: boolean;
  migratedAt: number | null;
}

const SEGMENT_MAX_BYTES = 64 * 1024 * 1024; // 64 MiB
const USAGE_DIR = "usage"; // relative to configDir

/**
 * Open or create the active segment for writing.
 * Triggers rotation when:
 * 1. Active segment exceeds SEGMENT_MAX_BYTES
 * 2. Local date has changed since last write
 */
export function openActiveSegment(configDir: string): {
  fd: number;
  segment: UsageSegment;
  rotated: boolean;
};

/**
 * Seal the current active segment (rename .active → plain .jsonl)
 * and create a new active segment.
 */
export function rotateSegment(configDir: string): UsageSegment;

/**
 * On startup: scan for orphan .active segments from crash recovery.
 * An orphan .active file (not the current active) is sealed in place.
 */
export function recoverOrphanSegments(configDir: string): UsageSegment[];

/**
 * Read and validate the manifest. Create if missing.
 */
export function readManifest(configDir: string): UsageSegmentManifest;

/**
 * Atomic manifest write (write to .tmp, rename).
 */
export function writeManifest(configDir: string, manifest: UsageSegmentManifest): void;

/**
 * Migrate from legacy single usage.jsonl:
 * 1. Rename usage.jsonl → usage/usage-legacy-0001.jsonl
 * 2. Create manifest marking it as sealed
 * 3. Create new active segment
 * Legacy file is preserved, not deleted.
 */
export function migrateLegacyUsageLog(configDir: string): UsageSegmentManifest;
```

### MODIFY: src/usage/log.ts

Replace the write path:

```diff
  export function appendUsageEntry(entry: PersistedUsageEntry): void {
-   ensureUsageLogDir();
-   const path = usageLogPath();
-   const line = JSON.stringify(normalizeUsageEntry(entry)) + "\n";
-   appendFileSync(path, line);
+   const { fd, segment, rotated } = openActiveSegment();
+   const line = JSON.stringify(normalizeUsageEntry(entry)) + "\n";
+   writeSync(fd, line);
+   segment.bytes += Buffer.byteLength(line);
+   segment.rows += 1;
+   segment.lastTimestamp = entry.startedAt ?? Date.now();
+   if (rotated) {
+     // Invalidate reader caches on rotation
+     discardRetainedUsageSnapshot();
+   }
```

Keep `usageLogPath()` working for backward compatibility (returns legacy path
or active segment path).

### MODIFY: src/usage/log.ts (reader)

Update `readUsageSnapshotForManagement` to read across segments:

```diff
+ // Read from all retained segments within the byte budget,
+ // newest first. The 64 MiB cap now applies to the total
+ // across segments, not a single file tail.
```

### NEW: tests/usage-segmented-writer.test.ts

Test cases:
1. Fresh install → creates usage/ dir + active segment + manifest
2. Append within segment → row count and bytes increase
3. Rotation at 64 MiB → new segment created, old sealed
4. Rotation at date change → new segment with new date prefix
5. Concurrent append → no row loss (serial appendFileSync)
6. Rotation boundary → no duplicate or missing entries
7. Crash recovery: orphan .active file → sealed on startup
8. Legacy migration: usage.jsonl → usage/ directory structure
9. Legacy file still readable after migration
10. Manifest corruption → rebuild from segment files

## Activation scenario

A user with a 245 MB `usage.jsonl` upgrades to this version. On first start,
`migrateLegacyUsageLog` moves it to `usage/usage-legacy-0001.jsonl` (sealed),
creates a manifest, and opens a new active segment. Subsequent appends go to
the active segment. After 64 MiB, it rotates to a new segment.

## Scope boundary

IN: Segment module, log.ts write/read path changes, migration, manifest, tests
OUT: SQLite projection (070), retention/deletion (P2), GUI changes, usage-summary-cache changes
