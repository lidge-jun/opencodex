import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { TRASH_DIR, toForwardSlash } from "./paths";
import type { ArchivedCandidate } from "./types";

export type StagedFile = { from: string; to: string; relPath: string };

export function absFromRel(codexHome: string, relPath: string): string {
  if (relPath.includes("..") || isAbsolute(relPath) || /^[A-Za-z]:[\\/]/.test(relPath)) {
    throw new Error("invalid_rel_path");
  }
  const abs = resolve(codexHome, ...relPath.split("/"));
  const homeAbs = resolve(codexHome);
  const rel = toForwardSlash(relative(homeAbs, abs));
  if (!rel || rel.startsWith("..")) throw new Error("path_escape");
  return abs;
}

export function stageCandidates(
  codexHome: string,
  candidates: ArchivedCandidate[],
  stageDir: string,
  opts?: { blockDestBasenames?: Set<string> },
): { ok: true; staged: StagedFile[] } | { ok: false; staged: StagedFile[] } {
  const staged: StagedFile[] = [];
  const usedBasenames = new Set<string>();
  try {
    mkdirSync(stageDir, { recursive: true });
    for (const candidate of candidates) {
      for (const rel of candidate.physicalRelPaths) {
        const from = absFromRel(codexHome, rel);
        const base = basename(rel);
        // archived_sessions/ is flat today; refuse collisions so a future nested walk
        // cannot silently overwrite another staged file.
        if (usedBasenames.has(base)) {
          throw new Error("stage_basename_collision");
        }
        usedBasenames.add(base);
        const to = join(stageDir, base);
        if (opts?.blockDestBasenames?.has(base)) {
          mkdirSync(to, { recursive: true });
        }
        renameSync(from, to);
        staged.push({ from, to, relPath: rel });
      }
    }
    return { ok: true, staged };
  } catch {
    return { ok: false, staged };
  }
}

/**
 * Rename staged files back to their originals.
 * Returns whether every staged file was restored. Unrestored entries stay in `remaining`.
 */
export function rollbackStaged(
  staged: StagedFile[],
  opts?: { failBasenames?: Set<string> },
): { restored: boolean; remaining: StagedFile[] } {
  const remaining: StagedFile[] = [];
  for (let i = staged.length - 1; i >= 0; i--) {
    const item = staged[i]!;
    const base = basename(item.to);
    if (opts?.failBasenames?.has(base)) {
      remaining.push(item);
      continue;
    }
    try {
      if (existsSync(item.to) && !existsSync(item.from)) {
        renameSync(item.to, item.from);
      } else if (existsSync(item.to)) {
        // Destination occupied — cannot restore without clobbering.
        remaining.push(item);
      }
    } catch {
      remaining.push(item);
    }
  }
  return { restored: remaining.length === 0, remaining };
}

export function purgeStaged(
  staged: StagedFile[],
  opts?: { failBasenames?: Set<string> },
): { purged: StagedFile[]; remaining: StagedFile[] } {
  const purged: StagedFile[] = [];
  const remaining: StagedFile[] = [];
  for (const item of staged) {
    const base = basename(item.to);
    if (opts?.failBasenames?.has(base)) {
      remaining.push(item);
      continue;
    }
    try {
      unlinkSync(item.to);
      purged.push(item);
    } catch {
      remaining.push(item);
    }
  }
  return { purged, remaining };
}

/** Remove stageDir only when it contains no unrestored staged files. */
export function removeStageIfEmpty(stageDir: string, remaining: StagedFile[]): void {
  if (remaining.length > 0) return;
  try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* */ }
}

export function removeEmptyTrashRoot(codexHome: string): void {
  try {
    const trashRoot = join(codexHome, TRASH_DIR);
    if (existsSync(trashRoot) && readdirSync(trashRoot).length === 0) {
      rmSync(trashRoot, { recursive: true, force: true });
    }
  } catch { /* */ }
}

export function trashRelPath(codexHome: string, stageDir: string): string {
  return toForwardSlash(relative(codexHome, stageDir) || stageDir);
}
