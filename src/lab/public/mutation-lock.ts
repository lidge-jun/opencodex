import { Database } from "bun:sqlite";
import { lstatSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sameFileIdentity, statTimeMs, type FileIdentity } from "../../lib/file-identity";
import { ensureLabDirs, labCommunityDir, labRoot } from "../paths";
import { readPrivateRegularFile } from "./file-safety";
import { PublicEvidenceValidationError } from "./validate";

const PUBLIC_EVIDENCE_MUTATION_DB_NAME = "public-evidence-mutation.sqlite";
const LEGACY_MUTATION_LOCK_NAME = ".mutation-lock";
const LEGACY_MUTATION_LOCK_OWNER = "owner.json";
const LEGACY_MUTATION_LOCK_INCOMPLETE_STALE_MS = 24 * 60 * 60 * 1000;
const LEGACY_MUTATION_LOCK_ABSOLUTE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const DETACHED_MUTATION_LOCK_RE = /^\.mutation-lock-(?:stale|release)-\d+-[0-9a-f-]{36}$/;
const LEGACY_OWNER_FILE_OPTIONS = {
  maxBytes: 1024,
  errorCode: "community_cache_lock",
  errorMessage: "community cache mutation lock metadata is unsafe",
  sizeErrorCode: "community_cache_lock",
  sizeErrorMessage: "community cache mutation lock metadata exceeds its size bound",
  requireMode600: true,
} as const;

type LegacyMutationLockOwner = {
  pid: number;
  createdAt: number;
};

function mutationLockDatabasePath(configDir?: string): string {
  return join(labRoot(configDir), PUBLIC_EVIDENCE_MUTATION_DB_NAME);
}

/** Lock bookkeeping entries an older build may leave in the community cache directory. */
export function isMutationLockEntryName(name: string): boolean {
  return name === LEGACY_MUTATION_LOCK_NAME || DETACHED_MUTATION_LOCK_RE.test(name);
}

function legacyMutationLockPath(configDir?: string): string {
  return join(labCommunityDir(configDir), LEGACY_MUTATION_LOCK_NAME);
}

function pidDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function readLegacyMutationLockOwner(lockPath: string): LegacyMutationLockOwner | null {
  try {
    const bytes = readPrivateRegularFile(join(lockPath, LEGACY_MUTATION_LOCK_OWNER), LEGACY_OWNER_FILE_OPTIONS);
    const raw = JSON.parse(bytes.toString("utf8")) as Partial<LegacyMutationLockOwner>;
    if (
      Number.isSafeInteger(raw.pid) && Number(raw.pid) > 0
      && Number.isSafeInteger(raw.createdAt) && Number(raw.createdAt) > 0
    ) return { pid: Number(raw.pid), createdAt: Number(raw.createdAt) };
  } catch {
    // Missing or malformed metadata falls back to the directory-age rule below.
  }
  return null;
}

function assertMutationLockDirectory(lockPath: string) {
  const stat = lstatSync(lockPath, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PublicEvidenceValidationError(
      "community_cache_lock",
      "community cache mutation lock is not a directory",
    );
  }
  return stat;
}

/**
 * Whether a directory lock left by an older OpenCodex build still has a holder.
 *
 * Older builds serialized through a `.mutation-lock` directory. This build never creates,
 * renames or removes one; it only declines to run beside a holder that still looks alive, using
 * the same evidence the older builds used: a live owner PID within the absolute age ceiling, or
 * an ownerless directory recent enough to be an acquisition in progress.
 */
function legacyMutationLockBlocks(lockPath: string, nowMs: number): boolean {
  let stat: ReturnType<typeof assertMutationLockDirectory>;
  try {
    stat = assertMutationLockDirectory(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const owner = readLegacyMutationLockOwner(lockPath);
  if (owner) {
    return !pidDefinitelyDead(owner.pid) && nowMs - owner.createdAt <= LEGACY_MUTATION_LOCK_ABSOLUTE_STALE_MS;
  }
  return nowMs - statTimeMs(stat.mtimeNs) <= LEGACY_MUTATION_LOCK_INCOMPLETE_STALE_MS;
}

function cleanupDetachedMutationLocks(configDir: string | undefined, nowMs: number): void {
  const dir = labCommunityDir(configDir);
  for (const name of readdirSync(dir)) {
    if (!DETACHED_MUTATION_LOCK_RE.test(name)) continue;
    const detachedPath = join(dir, name);
    // Older builds moved a released or reclaimed lock directory to one of these UUID-scoped
    // names before deleting it. One that still records a live owner may belong to a running
    // older-build holder, so it is left alone. Removing the rest keeps them from leaking
    // storage or being mistaken for community cache objects.
    const owner = readLegacyMutationLockOwner(detachedPath);
    if (owner && !pidDefinitelyDead(owner.pid) && nowMs - owner.createdAt <= LEGACY_MUTATION_LOCK_ABSOLUTE_STALE_MS) continue;
    rmSync(detachedPath, { recursive: true, force: true });
  }
}

/** The lock file's identity, after proving it is a single-link regular file. */
function mutationLockFileIdentity(path: string): FileIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new PublicEvidenceValidationError("community_cache_lock", "community cache mutation lock is unsafe");
  }
  return { dev: stat.dev, ino: stat.ino };
}

/**
 * Open the lock database on a file this module created as a private regular file.
 *
 * The Lab root is owner-only, so the processes that can replace this pathname are the user's own,
 * the same trust boundary as the config mutation lock. Within it, the file is created exclusively
 * with mode 0600 (never chmod-ed through the pathname), and the caller re-proves after locking
 * that the pathname still names the file inspected before the open.
 */
function openMutationLockDatabase(path: string): { database: Database; identity: FileIdentity } {
  try {
    writeFileSync(path, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const identity = mutationLockFileIdentity(path);
  try {
    return { database: new Database(path, { create: false, readwrite: true }), identity };
  } catch {
    // The SQLite error text can name local paths; the stable code is what callers act on.
    throw new PublicEvidenceValidationError("community_cache_lock", "community cache mutation lock is unavailable");
  }
}

/**
 * Serialize public-evidence mutations across CLI/server processes.
 *
 * The lock is an OS-held SQLite write transaction on a dedicated database, with
 * `busy_timeout=0` so a second holder fails fast as `community_cache_busy`. Closing the handle,
 * including at process exit or crash, releases it, so there is no stale-owner recovery and no
 * step that renames or deletes another process's lock state. Never return a Promise from `run`.
 */
export function withPublicEvidenceMutationLock<T>(
  configDir: string | undefined,
  run: () => T,
): T {
  ensureLabDirs(configDir);
  const path = mutationLockDatabasePath(configDir);
  const { database, identity } = openMutationLockDatabase(path);
  let transactionOpen = false;
  try {
    try {
      database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      transactionOpen = true;
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? String((cause as { code?: unknown }).code) : "";
      if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
        throw new PublicEvidenceValidationError("community_cache_busy", "community cache is busy");
      }
      throw new PublicEvidenceValidationError("community_cache_lock", "community cache mutation lock is unavailable");
    }
    if (!sameFileIdentity(mutationLockFileIdentity(path), identity)) {
      throw new PublicEvidenceValidationError("community_cache_lock", "community cache mutation lock changed while opening");
    }
    const nowMs = Date.now();
    if (legacyMutationLockBlocks(legacyMutationLockPath(configDir), nowMs)) {
      throw new PublicEvidenceValidationError("community_cache_busy", "community cache is busy");
    }
    cleanupDetachedMutationLocks(configDir, nowMs);
    return run();
  } finally {
    if (transactionOpen) {
      try { database.exec("ROLLBACK"); } catch { /* closing the handle below still releases the OS lock */ }
    }
    try { database.close(); } catch { /* the OS lock is released with the handle */ }
  }
}

/** Test-only seam for the older-build lock policy. This module is not barrel-exported. */
export function publicEvidenceLegacyMutationLockBlocksForTests(
  configDir: string | undefined,
  nowMs = Date.now(),
): boolean {
  return legacyMutationLockBlocks(legacyMutationLockPath(configDir), nowMs);
}
