import { rmSync } from "node:fs";
import { join } from "node:path";
import { resolveCodexHomeDir } from "../../codex/home";
import { discoverRuntimeDbPaths, probeStateDbWritable } from "./db";
import { createExclusiveStageDir, normalizeArchivedRolloutPath, writePrivateFile } from "./paths";
import { collectRestorePendingAcceptedDestRels } from "./pending";
import { candidateOverlapsPendingRestore, clampPercent, computeExactPreviewDigest, computePreviewDigest, listArchivedCandidates, previewArchivedCleanup, previewExactArchivedCleanup, resolveExactArchivedCandidates, selectOldestPercent } from "./preview";
import { loadThreadsForCleanup, reconcileDeletedThreads } from "./reconcile";
import type { ThreadSnapshot } from "./reconcile";
import { purgeStaged, removeEmptyTrashRoot, removeStageIfEmpty, rollbackStaged, stageCandidates, trashRelPath } from "./staging";
import type { ArchivedCandidate, CleanupErrorCode, CleanupManifestEntry, CleanupMode, CleanupPreview, CleanupResult } from "./types";

export interface ExecuteCleanupOptions {
  percent: number;
  mode: CleanupMode;
  /** Required digest from preview; rejects when the candidate set drifted. */
  digest: string;
  /**
   * Optional exact candidate set (logical relPaths). When set, selection bypasses
   * percent rounding and the digest must match `computeExactPreviewDigest`.
   */
  candidateRelPaths?: string[];
  codexHome?: string;
  /** Test-only: shrink busy_timeout so lock tests fail fast. */
  busyTimeoutMs?: number;
  now?: number;
  /** Test-only failure injection for atomicity regressions. */
  _test?: {
    failManifestWrite?: boolean;
    /** Observe the complete temp and prior destination before publication. Never serialized. */
    beforeManifestReplace?: (
      temporaryPath: string,
      targetPath: string,
      phase: "staging" | "pre-commit" | "purge-incomplete",
    ) => void;
    failPurgeBasenames?: string[];
    failRollbackBasenames?: string[];
    blockStageDestBasenames?: string[];
    failAfterLogsMutation?: boolean;
    failAfterMemoriesMutation?: boolean;
    failAfterGoalsMutation?: boolean;
    failBeforeStateCommit?: boolean;
    failSatelliteRestore?: boolean;
    failSatelliteBackupWrite?: boolean;
    failSatelliteBackupReplace?: boolean;
    afterSatelliteMutations?: () => void;
    beforeReconcileLock?: () => void;
  };
}

/** Serializable cleanup test hooks allowed on the management API wire. */
export type CleanupWireTestHooks = Omit<
  NonNullable<ExecuteCleanupOptions["_test"]>,
  "afterSatelliteMutations" | "beforeReconcileLock" | "beforeManifestReplace"
>;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(e => typeof e === "string");
}

/** Pick only allowlisted serializable hooks; drops all function hooks and unknown keys. */
export function pickWireCleanupTestHooks(raw: unknown): CleanupWireTestHooks | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const out: CleanupWireTestHooks = {};
  if (typeof o.failManifestWrite === "boolean") out.failManifestWrite = o.failManifestWrite;
  if (isStringArray(o.failPurgeBasenames)) out.failPurgeBasenames = o.failPurgeBasenames;
  if (isStringArray(o.failRollbackBasenames)) out.failRollbackBasenames = o.failRollbackBasenames;
  if (isStringArray(o.blockStageDestBasenames)) out.blockStageDestBasenames = o.blockStageDestBasenames;
  if (typeof o.failAfterLogsMutation === "boolean") out.failAfterLogsMutation = o.failAfterLogsMutation;
  if (typeof o.failAfterMemoriesMutation === "boolean") out.failAfterMemoriesMutation = o.failAfterMemoriesMutation;
  if (typeof o.failAfterGoalsMutation === "boolean") out.failAfterGoalsMutation = o.failAfterGoalsMutation;
  if (typeof o.failBeforeStateCommit === "boolean") out.failBeforeStateCommit = o.failBeforeStateCommit;
  if (typeof o.failSatelliteRestore === "boolean") out.failSatelliteRestore = o.failSatelliteRestore;
  if (typeof o.failSatelliteBackupWrite === "boolean") out.failSatelliteBackupWrite = o.failSatelliteBackupWrite;
  if (typeof o.failSatelliteBackupReplace === "boolean") out.failSatelliteBackupReplace = o.failSatelliteBackupReplace;
  return Object.keys(out).length > 0 ? out : undefined;
}

function fail(
  mode: CleanupMode,
  percent: number,
  error: CleanupErrorCode,
  extra?: { trashDir?: string },
): CleanupResult {
  return {
    ok: false,
    mode,
    percent,
    count: 0,
    bytes: 0,
    removedPaths: [],
    error,
    ...(extra?.trashDir ? { trashDir: extra.trashDir } : {}),
  };
}

/**
 * Execute archived cleanup bound to a preview digest.
 * Stages every physical file, writes the recovery manifest, then commits DB deletes.
 * Rollback never deletes a stage directory that still holds unrestored files.
 */
export function executeArchivedCleanup(options: ExecuteCleanupOptions): CleanupResult {
  const codexHome = options.codexHome ?? resolveCodexHomeDir();
  const mode = options.mode;
  const percent = clampPercent(options.percent);
  const busyTimeoutMs = options.busyTimeoutMs ?? 100;
  const failRollback = new Set(options._test?.failRollbackBasenames ?? []);
  const failPurge = new Set(options._test?.failPurgeBasenames ?? []);
  const blockStageDest = new Set(options._test?.blockStageDestBasenames ?? []);

  if (mode !== "quarantine" && mode !== "permanent") {
    return fail(mode, percent, "invalid_mode");
  }
  if (typeof options.digest !== "string" || !/^[a-f0-9]{64}$/i.test(options.digest)) {
    return fail(mode, percent, "invalid_digest");
  }

  let preview: CleanupPreview;
  let unfilteredSelected: ArchivedCandidate[];
  if (options.candidateRelPaths !== undefined) {
    const selected = resolveExactArchivedCandidates(options.candidateRelPaths, codexHome);
    if (selected === null) {
      return fail(mode, percent, "stale_preview");
    }
    unfilteredSelected = selected;
    preview = previewExactArchivedCleanup(selected, codexHome);
  } else {
    const all = listArchivedCandidates(codexHome);
    unfilteredSelected = selectOldestPercent(all, percent);
    preview = previewArchivedCleanup(percent, codexHome);
  }
  if (preview.digest.toLowerCase() !== options.digest.toLowerCase()) {
    const pendingDestRels = collectRestorePendingAcceptedDestRels(codexHome);
    const blocked = unfilteredSelected.filter(c => candidateOverlapsPendingRestore(c, pendingDestRels));
    const unfilteredDigest = options.candidateRelPaths !== undefined
      ? computeExactPreviewDigest(unfilteredSelected)
      : computePreviewDigest(unfilteredSelected, percent);
    if (
      unfilteredDigest.toLowerCase() === options.digest.toLowerCase()
      && blocked.length > 0
    ) {
      return fail(mode, percent, "restore_pending_overlap");
    }
    return fail(mode, percent, "stale_preview");
  }
  const pendingDestRels = collectRestorePendingAcceptedDestRels(codexHome);
  if (preview.candidates.some(c => candidateOverlapsPendingRestore(c, pendingDestRels))) {
    return fail(mode, percent, "restore_pending_overlap");
  }

  if (preview.candidates.length === 0) {
    return {
      ok: true,
      mode,
      percent,
      count: 0,
      bytes: 0,
      removedPaths: [],
    };
  }

  const paths = discoverRuntimeDbPaths(codexHome);
  const probe = probeStateDbWritable(codexHome, busyTimeoutMs);
  if (!probe.ok) {
    return fail(mode, percent, probe.error);
  }

  // Preflight referenced-history / matching while DB is free, before any rename.
  const loaded = loadThreadsForCleanup(paths.state ?? "", preview.candidates, codexHome, busyTimeoutMs);
  if (!loaded.ok) {
    return fail(mode, percent, loaded.error);
  }

  const epoch = options.now ?? Date.now();
  let stageDir: string;
  try {
    stageDir = createExclusiveStageDir(codexHome, epoch);
  } catch {
    return fail(mode, percent, "fs_failed");
  }
  const trashDir = trashRelPath(codexHome, stageDir);

  const threadByRelPath = new Map<string, ThreadSnapshot>();
  for (const thread of loaded.threads) {
    const normalized = normalizeArchivedRolloutPath(thread.rollout_path, codexHome);
    if (normalized) threadByRelPath.set(normalized, thread);
  }
  const skippedReferencedPaths = loaded.skipped
    .map(thread => normalizeArchivedRolloutPath(thread.rollout_path, codexHome))
    .filter((path): path is string => path !== null);
  const matchedPaths = new Set([
    ...threadByRelPath.keys(),
    ...skippedReferencedPaths,
  ]);
  const candidates = preview.candidates.filter(candidate => {
    return !matchedPaths.has(candidate.relPath) || threadByRelPath.has(candidate.relPath);
  });
  if (candidates.length === 0) {
    removeStageIfEmpty(stageDir, []);
    removeEmptyTrashRoot(codexHome);
    return {
      ok: true,
      mode,
      percent,
      count: 0,
      bytes: 0,
      removedPaths: [],
      ...(skippedReferencedPaths.length ? { skippedReferencedPaths } : {}),
    };
  }
  const manifestEntries: CleanupManifestEntry[] = candidates.map(candidate => {
    const thread = threadByRelPath.get(candidate.relPath);
    return {
      relPath: candidate.relPath,
      bytes: candidate.bytes,
      mtimeMs: candidate.mtimeMs,
      physicalRelPaths: candidate.physicalRelPaths,
      ...(thread
        ? { threadId: thread.id, rolloutPath: thread.rollout_path, archived: thread.archived }
        : {}),
    };
  });

  const writeManifest = (extra: Record<string, unknown> = {}) => {
    writePrivateFile(
      join(stageDir, "manifest.json"),
      JSON.stringify({
        quarantinedAt: epoch,
        mode,
        percent,
        digest: preview.digest,
        entries: manifestEntries,
        ...extra,
      }, null, 2),
      (temporaryPath, targetPath) => options._test?.beforeManifestReplace?.(
        temporaryPath, targetPath, extra.staging ? "staging" : "pre-commit",
      ),
    );
  };

  // Journal staged paths before the first rename so a crash mid-stage is recoverable.
  try {
    if (options._test?.failManifestWrite) {
      throw new Error("test_fail_manifest_write");
    }
    writeManifest({ staging: true });
  } catch {
    removeStageIfEmpty(stageDir, []);
    return fail(mode, percent, "fs_failed");
  }

  const stageResult = stageCandidates(codexHome, candidates, stageDir, {
    blockDestBasenames: blockStageDest.size > 0 ? blockStageDest : undefined,
  });
  if (!stageResult.ok) {
    const rolled = rollbackStaged(stageResult.staged, { failBasenames: failRollback });
    removeStageIfEmpty(stageDir, rolled.remaining);
    return fail(mode, percent, "fs_failed", rolled.restored ? undefined : { trashDir });
  }

  // Final manifest before DB deletion so a mid-flight crash still has recovery metadata.
  try {
    writeManifest();
  } catch {
    const rolled = rollbackStaged(stageResult.staged, { failBasenames: failRollback });
    removeStageIfEmpty(stageDir, rolled.remaining);
    return fail(mode, percent, "fs_failed", rolled.restored ? undefined : { trashDir });
  }

  const deleted = reconcileDeletedThreads(
    paths,
    candidates,
    codexHome,
    busyTimeoutMs,
    stageDir,
    options._test,
  );
  if (!deleted.ok) {
    const rolled = rollbackStaged(stageResult.staged, { failBasenames: failRollback });
    // Keep the stage (and recovery manifest) when files or satellite DB rows remain unrestored.
    const keepTrash = Boolean(deleted.satelliteRestoreFailed) || !rolled.restored;
    if (!keepTrash) {
      removeStageIfEmpty(stageDir, rolled.remaining);
      removeEmptyTrashRoot(codexHome);
    }
    return fail(mode, percent, deleted.error, keepTrash ? { trashDir } : undefined);
  }

  const removedPaths = candidates.map(c => c.relPath);
  const bytes = candidates.reduce((sum, c) => sum + c.bytes, 0);

  if (mode === "quarantine") {
    return {
      ok: true,
      mode,
      percent,
      count: removedPaths.length,
      bytes,
      trashDir,
      removedPaths,
      ...(skippedReferencedPaths.length ? { skippedReferencedPaths } : {}),
    };
  }

  // Permanent: purge staged files only after a successful DB commit.
  const purge = purgeStaged(stageResult.staged, { failBasenames: failPurge });
  if (purge.remaining.length > 0) {
    // Overwrite the pre-commit manifest so recovery reflects what actually survived.
    const survivingRelPaths = new Set(purge.remaining.map(item => item.relPath));
    try {
      writePrivateFile(
        join(stageDir, "manifest.json"),
        JSON.stringify({
          quarantinedAt: epoch,
          mode: "permanent",
          percent,
          digest: preview.digest,
          purgeIncomplete: true,
          purgedRelPaths: purge.purged.map(item => item.relPath),
          entries: manifestEntries
            .map(entry => ({
              ...entry,
              physicalRelPaths: entry.physicalRelPaths.filter(rel => survivingRelPaths.has(rel)),
            }))
            .filter(entry => entry.physicalRelPaths.length > 0),
        }, null, 2),
        (temporaryPath, targetPath) => options._test?.beforeManifestReplace?.(
          temporaryPath, targetPath, "purge-incomplete",
        ),
      );
    } catch { /* best-effort: the pre-commit manifest is still on disk */ }
    return {
      ok: false,
      mode,
      percent,
      count: 0,
      bytes: 0,
      trashDir,
      removedPaths: [],
      error: "fs_failed",
    };
  }

  try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* empty dir */ }
  // Drop an empty `.trash` root so permanent cleanup leaves no quarantine tree behind.
  removeEmptyTrashRoot(codexHome);

  return {
    ok: true,
    mode,
    percent,
    count: removedPaths.length,
    bytes,
    removedPaths,
    ...(skippedReferencedPaths.length ? { skippedReferencedPaths } : {}),
  };
}
