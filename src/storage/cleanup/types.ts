export type CleanupMode = "quarantine" | "permanent";

/** Mapped failure codes only — never embed absolute host paths. */
export type CleanupErrorCode =
  | "invalid_mode"
  | "invalid_digest"
  | "stale_preview"
  | "codex_busy"
  | "storage_mutation_busy"
  | "fs_failed"
  | "db_reconcile_failed"
  | "referenced_history"
  | "pinned_thread"
  | "restore_pending_overlap"
  | "cleanup_failed";

export interface ArchivedCandidate {
  /** Path relative to CODEX_HOME, forward-slash separated (logical `.jsonl` path). */
  relPath: string;
  absPath: string;
  bytes: number;
  mtimeMs: number;
  /** All physical files for this logical rollout (`.jsonl` and/or `.jsonl.zst`). */
  physicalRelPaths: string[];
  /** Per-physical-file metadata bound into the preview digest. */
  physicalFiles: Array<{ relPath: string; bytes: number; mtimeMs: number }>;
}

export interface CleanupPreview {
  codexHome: string;
  percent: number;
  count: number;
  bytes: number;
  /** HMAC-free content digest binding execute to this exact candidate set. */
  digest: string;
  candidates: ArchivedCandidate[];
}

export interface CleanupManifestEntry {
  relPath: string;
  bytes: number;
  mtimeMs: number;
  physicalRelPaths: string[];
  threadId?: string;
  rolloutPath?: string;
  archived?: number | null;
}

export interface CleanupResult {
  ok: boolean;
  mode: CleanupMode;
  percent: number;
  count: number;
  bytes: number;
  trashDir?: string;
  error?: CleanupErrorCode;
  removedPaths: string[];
  skippedReferencedPaths?: string[];
}

// ---------------------------------------------------------------------------
// Phase 2.1 — quarantine list + restore
// ---------------------------------------------------------------------------

export type RestoreErrorCode =
  | "invalid_trash"
  | "missing_trash"
  | "codex_busy"
  | "storage_mutation_busy"
  | "fs_failed"
  | "db_reconcile_failed"
  | "dest_exists"
  | "restore_failed"
  | "restore_worker_timeout"
  | "restore_worker_aborted"
  | "restore_worker_failed";

export interface TrashEntrySummary {
  /** CODEX_HOME-relative path, e.g. `.trash/1700000000000`. */
  id: string;
  /** Epoch directory name (may include collision suffix, e.g. `1700-1`). */
  epoch: string;
  fileCount: number;
  bytes: number;
  quarantinedAt?: number;
  mode?: CleanupMode;
}

export interface RestoreResult {
  ok: boolean;
  trashDir?: string;
  count: number;
  bytes: number;
  restoredPaths: string[];
  error?: RestoreErrorCode;
  /** Optional operator-facing detail when the error code alone is insufficient. */
  message?: string;
}
