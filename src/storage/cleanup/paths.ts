import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { renameAtomicFile } from "../../lib/windows-atomic-replace";

export const ARCHIVED_SESSIONS_DIR = "archived_sessions";

export const TRASH_DIR = ".trash";

const JSONL_SUFFIX = ".jsonl";

export const ZST_SUFFIX = ".jsonl.zst";

export function chmodPrivatePath(path: string, mode: number): void {
  try { chmodSync(path, mode); } catch { /* best-effort (e.g. Windows ACLs) */ }
}

/** Publish complete stage metadata without truncating the last recovery record. */
export function writePrivateFile(
  path: string,
  content: string,
  beforeRename?: (temporaryPath: string, targetPath: string) => void,
): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    created = true;
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodPrivatePath(temporaryPath, 0o600);
    beforeRename?.(temporaryPath, path);
    renameAtomicFile(temporaryPath, path, undefined, "storage-cleanup");
    chmodPrivatePath(path, 0o600);
    fsyncDirectoryBestEffort(dirname(path));
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve publication failure */ }
    }
    if (created) {
      try { unlinkSync(temporaryPath); } catch { /* renamed or cleanup unavailable */ }
    }
  }
}

/** Create `.trash/<epoch>` exclusively; suffix on collision. */
export function createExclusiveStageDir(codexHome: string, epoch: number): string {
  const trashRoot = join(codexHome, TRASH_DIR);
  mkdirSync(trashRoot, { recursive: true });
  chmodPrivatePath(trashRoot, 0o700);
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = attempt === 0 ? String(epoch) : `${epoch}-${attempt}`;
    const stageDir = join(trashRoot, name);
    try {
      mkdirSync(stageDir);
      chmodPrivatePath(stageDir, 0o700);
      return stageDir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("stage_dir_collision");
}

export function isSafeArchiveFileName(name: string): boolean {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  return isRolloutFileName(name);
}

export function toForwardSlash(p: string): string {
  return p.split(sep).join("/");
}

/** Strip trailing `.zst` so plain + compressed share one logical rollout id. */
export function logicalRolloutRelPath(relPath: string): string {
  const normalized = toForwardSlash(relPath);
  return normalized.endsWith(ZST_SUFFIX)
    ? normalized.slice(0, -".zst".length)
    : normalized;
}

export function isRolloutFileName(name: string): boolean {
  return name.endsWith(ZST_SUFFIX) || name.endsWith(JSONL_SUFFIX);
}

/**
 * Normalize a DB `rollout_path` to a CODEX_HOME-relative forward-slash path, then
 * to the logical `.jsonl` form. Returns null when the path is not under
 * `archived_sessions/` (rejects active `sessions/` and foreign paths).
 */
export function normalizeArchivedRolloutPath(rolloutPath: string, codexHome: string): string | null {
  const raw = toForwardSlash(rolloutPath.trim());
  if (!raw) return null;
  let relativePath = raw;
  try {
    // Prefer Node's absolute-path detection. Do not treat a colon anywhere in the
    // filename (Codex ISO timestamps) as an absolute Windows path.
    const looksAbsolute = isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw);
    const abs = looksAbsolute ? resolve(raw) : resolve(codexHome, raw);
    const homeAbs = resolve(codexHome);
    const rel = toForwardSlash(relative(homeAbs, abs));
    if (rel.startsWith("..") || rel === "") return null;
    relativePath = rel;
  } catch {
    return null;
  }
  const logical = logicalRolloutRelPath(relativePath);
  if (!logical.startsWith(`${ARCHIVED_SESSIONS_DIR}/`)) return null;
  if (!logical.endsWith(JSONL_SUFFIX)) return null;
  // Reject path tricks: only a single file under archived_sessions/
  const rest = logical.slice(ARCHIVED_SESSIONS_DIR.length + 1);
  if (!rest || rest.includes("/") || rest.includes("..")) return null;
  return logical;
}

/**
 * Same-volume move that never replaces an existing destination.
 *
 * `existsSync` + `renameSync` is TOCTOU: a live file created between the check
 * and rename can be overwritten (Windows rename replaces files). Hard-link then
 * unlink fails with EEXIST if `to` appears, which is what trash → archived_sessions
 * restore needs. Callers under the same `CODEX_HOME` volume should not hit EXDEV.
 */
export function renameNoReplace(from: string, to: string): void {
  try {
    linkSync(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    // Hard links unavailable (rare FS) — refuse rather than clobber via rename.
    if (code === "EXDEV" || code === "EPERM" || code === "ENOTSUP" || code === "EINVAL") {
      throw Object.assign(new Error("rename_no_replace_unsupported"), { code, cause: error });
    }
    throw error;
  }
  try {
    unlinkSync(from);
  } catch (error) {
    // Roll back the hard link so we do not leave the file at both paths.
    try { unlinkSync(to); } catch { /* best-effort */ }
    throw error;
  }
}

export function isExistError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

/**
 * Best-effort directory fsync so a preceding rename is durable on crash.
 * Unsupported on some Windows setups — never treat failure as fatal.
 */
function fsyncDirectoryBestEffort(dirPath: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirPath, "r");
    fsyncSync(fd);
  } catch {
    /* best-effort */
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* */ }
    }
  }
}

/** Epoch dir names: digits, optionally `-N` from createExclusiveStageDir collision. */
export const TRASH_EPOCH_DIR = /^(\d+)(-\d+)?$/;

export function isSafeArchivedPhysicalRel(rel: string): boolean {
  const normalized = toForwardSlash(rel);
  if (!normalized.startsWith(`${ARCHIVED_SESSIONS_DIR}/`)) return false;
  if (normalized.includes("..")) return false;
  const rest = normalized.slice(ARCHIVED_SESSIONS_DIR.length + 1);
  if (!rest || rest.includes("/")) return false;
  return isRolloutFileName(rest);
}
