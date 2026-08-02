# 010 — Fix #858: archived-session cleanup must exclude pinned threads

Root cause (investigator Einstein, verified): `loadMatchingThreads()`
(`src/storage/cleanup.ts:571`) selects `id, rollout_path, archived?,
history_mode?` — never `is_pinned`. The filter at :586 checks archived +
path membership only. The destructive path: previewArchivedCleanup (:433,
filesystem-only) -> executeArchivedCleanup (:1759) -> stageCandidates
(:1857) -> reconcileDeletedThreads (:1473, BEGIN IMMEDIATE, reload without
is_pinned) -> deleteThreadsAndDependents (:691) -> purge (:1909). Policy
cleanup shares the path (policy.ts:447,460). Filtering only before SQL
deletion is insufficient: the rollout file is staged/purged regardless.

## Fix

1. Detect `threads.is_pinned` with the existing `columnExists()` mechanism;
   select it alongside the other optional columns.
2. Exclude candidates whose normalized rollout path belongs to a row with
   `is_pinned = 1` before percentage/exact selection in
   `previewArchivedCleanup()` and `previewExactArchivedCleanup()`, and in
   policy selection.
3. Under the write lock (`reconcileDeletedThreads`, :1473), re-check the
   reloaded rows and abort with ROLLBACK + stale_preview-style result when
   any candidate became pinned (closes the preview->execution race; the
   caller restores staged files).
4. Missing column (older schema) preserves existing behavior; query failure
   propagates the existing fail-closed DB error.

## Tests (tests/storage-cleanup.test.ts, fixture at :148-154)

- `test.each(["quarantine","permanent"])`: pinned oldest archived thread is
  excluded from preview; execution keeps both the rollout file and the DB
  row; selection backfills the next-oldest.
- Pin after preview, before execution -> stale_preview, staged files
  restored.
- Older schema without is_pinned -> existing tests stay green.
- Policy coverage in tests/storage-policy.test.ts for percentage and
  reduceToBytes targets.
