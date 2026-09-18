import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { resolveCodexHomeDir } from "../../codex/home";
import { columnExists, discoverRuntimeDbPaths, tableExists } from "./db";
import { ARCHIVED_SESSIONS_DIR, isSafeArchiveFileName, logicalRolloutRelPath, normalizeArchivedRolloutPath } from "./paths";
import { collectRestorePendingAcceptedDestRels } from "./pending";
import type { ArchivedCandidate, CleanupPreview } from "./types";

export function clampPercent(percent: unknown): number {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.floor(percent)));
}

function candidateDigestLines(candidates: ArchivedCandidate[]): string[] {
  return candidates
    .map(c => {
      const physical = [...c.physicalFiles]
        .sort((a, b) => a.relPath.localeCompare(b.relPath))
        .map(f => `${f.relPath}|${f.bytes}|${Math.trunc(f.mtimeMs)}`)
        .join(",");
      return `${c.relPath}|${c.bytes}|${Math.trunc(c.mtimeMs)}|${physical}`;
    })
    .sort();
}

/** Content digest of the exact previewed candidate set (paths + size + mtime). */
export function computePreviewDigest(candidates: ArchivedCandidate[], percent: number): string {
  return createHash("sha256")
    .update(`${clampPercent(percent)}\n${candidateDigestLines(candidates).join("\n")}`)
    .digest("hex");
}

/**
 * Digest bound to an explicit candidate list (not a percent selection).
 * Used when reduceToBytes needs an exact count that percent rounding cannot represent.
 */
export function computeExactPreviewDigest(candidates: ArchivedCandidate[]): string {
  return createHash("sha256")
    .update(`exact\n${candidateDigestLines(candidates).join("\n")}`)
    .digest("hex");
}

/** List archived rollout groups oldest-first. Never walks `sessions/`. */
export function listArchivedCandidates(codexHome: string): ArchivedCandidate[] {
  const dir = join(codexHome, ARCHIVED_SESSIONS_DIR);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  type Acc = {
    logicalRel: string;
    files: Array<{ name: string; absPath: string; relPath: string; bytes: number; mtimeMs: number }>;
  };
  const groups = new Map<string, Acc>();

  for (const name of names) {
    if (!isSafeArchiveFileName(name)) continue;
    const absPath = join(dir, name);
    try {
      const st = statSync(absPath);
      if (!st.isFile()) continue;
      const relPath = `${ARCHIVED_SESSIONS_DIR}/${name}`;
      const logicalRel = logicalRolloutRelPath(relPath);
      let acc = groups.get(logicalRel);
      if (!acc) {
        acc = { logicalRel, files: [] };
        groups.set(logicalRel, acc);
      }
      acc.files.push({
        name,
        absPath,
        relPath,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      /* vanished mid-scan */
    }
  }

  const out: ArchivedCandidate[] = [];
  for (const acc of groups.values()) {
    // Prefer the plain `.jsonl` path as the public/logical identity when both exist.
    acc.files.sort((a, b) => a.relPath.localeCompare(b.relPath));
    const primary =
      acc.files.find(f => f.relPath === acc.logicalRel) ??
      acc.files[0]!;
    out.push({
      relPath: acc.logicalRel,
      absPath: primary.absPath,
      bytes: acc.files.reduce((sum, f) => sum + f.bytes, 0),
      mtimeMs: Math.min(...acc.files.map(f => f.mtimeMs)),
      physicalRelPaths: acc.files.map(f => f.relPath),
      physicalFiles: acc.files.map(f => ({ relPath: f.relPath, bytes: f.bytes, mtimeMs: f.mtimeMs })),
    });
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs || a.relPath.localeCompare(b.relPath));
  return out;
}

export function selectOldestPercent(candidates: ArchivedCandidate[], percent: number): ArchivedCandidate[] {
  const pct = clampPercent(percent);
  if (pct <= 0 || candidates.length === 0) return [];
  if (pct >= 100) return [...candidates];
  const n = percentSelectionTargetCount(candidates.length, pct);
  return candidates.slice(0, n);
}

/** Count implied by percent selection over the full candidate list. */
export function percentSelectionTargetCount(totalCount: number, percent: number): number {
  const pct = clampPercent(percent);
  if (pct <= 0 || totalCount === 0) return 0;
  if (pct >= 100) return totalCount;
  return Math.max(1, Math.floor((totalCount * pct) / 100));
}

export function candidateOverlapsPendingRestore(
  candidate: ArchivedCandidate,
  pendingDestRels: ReadonlySet<string>,
): boolean {
  if (pendingDestRels.size === 0) return false;
  for (const rel of candidate.physicalRelPaths) {
    if (pendingDestRels.has(rel)) return true;
  }
  return pendingDestRels.has(candidate.relPath);
}

/** Drop cleanup candidates whose physical paths overlap an in-progress restore. */
export function filterCandidatesExcludingPendingRestore(
  candidates: ArchivedCandidate[],
  codexHome: string = resolveCodexHomeDir(),
): ArchivedCandidate[] {
  const pendingDestRels = collectRestorePendingAcceptedDestRels(codexHome);
  if (pendingDestRels.size === 0) return candidates;
  return candidates.filter(c => !candidateOverlapsPendingRestore(c, pendingDestRels));
}

/**
 * Oldest-first percent selection that skips pending-restore destinations without
 * consuming the percent budget, backfilling with the next oldest safe candidates.
 */
export function selectOldestPercentSkippingPendingRestore(
  candidates: ArchivedCandidate[],
  percent: number,
  codexHome: string = resolveCodexHomeDir(),
): ArchivedCandidate[] {
  const target = percentSelectionTargetCount(candidates.length, percent);
  if (target === 0) return [];
  const pendingDestRels = collectRestorePendingAcceptedDestRels(codexHome);
  const out: ArchivedCandidate[] = [];
  for (const c of candidates) {
    if (candidateOverlapsPendingRestore(c, pendingDestRels)) continue;
    out.push(c);
    if (out.length >= target) break;
  }
  return out;
}

/**
 * Reduce archived total toward `reduceToBytes` using oldest safe candidates only.
 * Pending-restore destinations are skipped and do not count toward bytes freed.
 */
export function selectReduceToBytesSkippingPendingRestore(
  candidates: ArchivedCandidate[],
  reduceToBytes: number,
  codexHome: string = resolveCodexHomeDir(),
): ArchivedCandidate[] {
  if (!Number.isFinite(reduceToBytes) || reduceToBytes < 0) return [];
  const total = candidates.reduce((sum, c) => sum + c.bytes, 0);
  if (total <= reduceToBytes) return [];
  const need = total - reduceToBytes;
  const pendingDestRels = collectRestorePendingAcceptedDestRels(codexHome);
  const out: ArchivedCandidate[] = [];
  let freed = 0;
  for (const c of candidates) {
    if (candidateOverlapsPendingRestore(c, pendingDestRels)) continue;
    out.push(c);
    freed += c.bytes;
    if (freed >= need) break;
  }
  return out;
}

/**
 * Normalized rollout paths of pinned threads. Pinned threads are never
 * cleanup candidates: a pin is the user's explicit "keep this" signal and
 * deleting its rollout would be permanent task-data loss (#858).
 *
 * Selection-time use is advisory: on any DB problem this returns an empty
 * set, and the write-locked re-check inside reconcileDeletedThreads stays
 * the fail-closed gate. Older schemas without `is_pinned` keep prior
 * behavior.
 */
function collectPinnedArchivedRolloutPaths(codexHome: string): Set<string> {
  const statePath = discoverRuntimeDbPaths(codexHome).state;
  if (!statePath || !existsSync(statePath)) return new Set();
  let db: Database | undefined;
  try {
    db = new Database(statePath, { readonly: true });
    if (!tableExists(db, "threads") || !columnExists(db, "threads", "is_pinned")) {
      return new Set();
    }
    const rows = db.query<{ rollout_path: string }, []>(
      `SELECT rollout_path FROM threads WHERE is_pinned = 1`,
    ).all();
    const out = new Set<string>();
    for (const row of rows) {
      const normalized = normalizeArchivedRolloutPath(row.rollout_path, codexHome);
      if (normalized) out.add(normalized);
    }
    return out;
  } catch {
    return new Set();
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

/** Drop candidates whose rollout belongs to a pinned thread (#858). */
export function filterCandidatesExcludingPinned(
  candidates: ArchivedCandidate[],
  codexHome: string,
): ArchivedCandidate[] {
  const pinned = collectPinnedArchivedRolloutPaths(codexHome);
  if (pinned.size === 0) return candidates;
  return candidates.filter(c => !pinned.has(c.relPath));
}

export function previewArchivedCleanup(
  percent: number,
  codexHome: string = resolveCodexHomeDir(),
): CleanupPreview {
  const all = listArchivedCandidates(codexHome);
  const safe = selectOldestPercentSkippingPendingRestore(
    filterCandidatesExcludingPinned(all, codexHome),
    percent,
    codexHome,
  );
  const pct = clampPercent(percent);
  return {
    codexHome,
    percent: pct,
    count: safe.length,
    bytes: safe.reduce((sum, c) => sum + c.bytes, 0),
    digest: computePreviewDigest(safe, pct),
    candidates: safe,
  };
}

/** Preview bound to an explicit candidate set (exact digest, percent left at 0). */
export function previewExactArchivedCleanup(
  candidates: ArchivedCandidate[],
  codexHome: string = resolveCodexHomeDir(),
): CleanupPreview {
  const safe = filterCandidatesExcludingPinned(
    filterCandidatesExcludingPendingRestore(candidates, codexHome),
    codexHome,
  );
  return {
    codexHome,
    percent: 0,
    count: safe.length,
    bytes: safe.reduce((sum, c) => sum + c.bytes, 0),
    digest: computeExactPreviewDigest(safe),
    candidates: safe,
  };
}

/**
 * Resolve an exact candidate list from current archive state.
 * Returns null when any requested path is missing or drifted (caller maps to stale_preview).
 */
export function resolveExactArchivedCandidates(
  candidateRelPaths: string[],
  codexHome: string = resolveCodexHomeDir(),
): ArchivedCandidate[] | null {
  if (!Array.isArray(candidateRelPaths) || candidateRelPaths.length === 0) return [];
  const all = listArchivedCandidates(codexHome);
  const byRel = new Map(all.map(c => [c.relPath, c]));
  const selected: ArchivedCandidate[] = [];
  for (const rel of candidateRelPaths) {
    const hit = byRel.get(rel);
    if (!hit) return null;
    selected.push(hit);
  }
  return selected;
}
