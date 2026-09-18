/**
 * Phase 2 archived-session cleanup (issue #42 Option A).
 *
 * Preview + execute for files under `archived_sessions/` only. Active `sessions/`
 * are never touched. Default mode quarantines into `CODEX_HOME/.trash/<epoch>/`;
 * permanent delete is opt-in.
 *
 * Execution is bound to a preview digest. All candidates are staged first; any FS
 * Freezes the thread-ID set under the state write lock, persists a complete
 * satellite-backup.json before any satellite delete commit, then mutates
 * `logs_*` → `memories_*` → `goals_*` → `state_*`. Later failures restore
 * satellite rows before staged files. Success never carries soft `dbWarning` /
 * `failedPaths`.
 *
 * Implementation lives in the `./cleanup/` leaf modules; this file is the
 * stable public surface and re-exports every original name.
 */
export { ARCHIVED_SESSIONS_DIR, TRASH_DIR } from "./cleanup/paths";
export {
  logicalRolloutRelPath,
  normalizeArchivedRolloutPath,
} from "./cleanup/paths";
export type {
  ArchivedCandidate,
  CleanupErrorCode,
  CleanupManifestEntry,
  CleanupMode,
  CleanupPreview,
  CleanupResult,
  RestoreErrorCode,
  RestoreResult,
  TrashEntrySummary,
} from "./cleanup/types";
export { probeStateDbWritable } from "./cleanup/db";
export { collectRestorePendingAcceptedDestRels } from "./cleanup/pending";
export {
  computeExactPreviewDigest,
  computePreviewDigest,
  filterCandidatesExcludingPendingRestore,
  filterCandidatesExcludingPinned,
  listArchivedCandidates,
  percentSelectionTargetCount,
  previewArchivedCleanup,
  previewExactArchivedCleanup,
  resolveExactArchivedCandidates,
  selectOldestPercent,
  selectOldestPercentSkippingPendingRestore,
  selectReduceToBytesSkippingPendingRestore,
} from "./cleanup/preview";
export {
  executeArchivedCleanup,
  pickWireCleanupTestHooks,
} from "./cleanup/execute";
export type {
  CleanupWireTestHooks,
  ExecuteCleanupOptions,
} from "./cleanup/execute";
export {
  listTrashEntries,
  resolveTrashStageDir,
  restoreTrashEntry,
} from "./cleanup/restore";
export type { RestoreTestHooks } from "./cleanup/restore";
