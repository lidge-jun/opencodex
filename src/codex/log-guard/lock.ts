import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { Database } from "bun:sqlite";

import {
  normalizeTrustedDarwinSystemAlias,
  sameLogGuardPathIdentity,
} from "./path-safety";
import { isSqliteBusy } from "./sqlite-errors";

import {
  CodexUserIdentityRefusal,
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../user-identity";

export type CodexLogGuardLockOutcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "unavailable"; reason: "busy" | "database" | "unsafe-path" };

export interface CodexLogGuardLockDeps {
  /** Test seam. Production resolves a dedicated DB in the trusted user runtime root. */
  resolveDatabasePath?: (canonicalCodexHome: string, canonicalLogsDbPath: string) => string;
}

function lockFileIsSafe(path: string, requireRealpath: boolean): boolean {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) return false;
  if (requireRealpath && !sameLogGuardPathIdentity(realpathSync.native(path), path)) return false;
  if (process.platform === "win32") return true;
  const uid = process.getuid?.();
  return uid !== undefined && stat.uid === uid && (stat.mode & 0o777) === 0o600;
}

export function codexLogGuardLockDigest(
  canonicalCodexHome: string,
  canonicalLogsDbPath: string,
): string {
  const digestCodexHome = normalizeTrustedDarwinSystemAlias(canonicalCodexHome);
  const digestLogsDbPath = normalizeTrustedDarwinSystemAlias(canonicalLogsDbPath);
  return createHash("sha256")
    .update(`${digestCodexHome.length}:${digestCodexHome}`)
    .update(`${digestLogsDbPath.length}:${digestLogsDbPath}`)
    .digest("hex");
}

function resolveLogGuardLockDatabase(
  canonicalCodexHome: string,
  canonicalLogsDbPath: string,
): string {
  if (!isAbsolute(canonicalCodexHome) || !isAbsolute(canonicalLogsDbPath)) {
    throw new CodexUserIdentityRefusal("Codex Log Guard lock keys must be absolute paths.");
  }

  const identity = resolveEffectiveUserIdentity();
  // Use the native-coordinator resolver only to enter the already-audited,
  // environment-independent per-user runtime root. L itself is a different
  // database in a sibling directory and never acquires N or H.
  const coordinatorPath = resolveCodexCoordinatorDatabasePath(identity, canonicalCodexHome);
  const runtimeRoot = dirname(dirname(coordinatorPath));
  const locksDir = join(runtimeRoot, "log-guard-locks");
  mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(locksDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()
    || !sameLogGuardPathIdentity(realpathSync.native(locksDir), locksDir)) {
    throw new CodexUserIdentityRefusal("Codex Log Guard lock directory is unsafe.");
  }
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    // `mkdirSync` applies `mode` only when it CREATES the directory, so a
    // directory left by an earlier build (or a permissive umask on a older
    // version) keeps its old permissions forever and every Log Guard mutation
    // fails `unsafe_path` with no in-product way out. Tighten it ourselves when
    // we own it, and only refuse if that cannot be achieved.
    if (uid === undefined || dirStat.uid !== uid) {
      throw new CodexUserIdentityRefusal("Codex Log Guard lock directory is not private to the effective user.");
    }
    if ((dirStat.mode & 0o777) !== 0o700) {
      try {
        chmodSync(locksDir, 0o700);
      } catch {
        throw new CodexUserIdentityRefusal("Codex Log Guard lock directory is not private to the effective user.");
      }
      // Re-read rather than trusting the chmod: a filesystem that ignores mode
      // bits must still fail closed.
      if ((lstatSync(locksDir).mode & 0o777) !== 0o700) {
        throw new CodexUserIdentityRefusal("Codex Log Guard lock directory is not private to the effective user.");
      }
    }
  }

  return join(locksDir, `${codexLogGuardLockDigest(canonicalCodexHome, canonicalLogsDbPath)}.sqlite`);
}

export function withCodexLogGuardLock<T>(
  canonicalCodexHome: string,
  canonicalLogsDbPath: string,
  work: () => T,
  deps: CodexLogGuardLockDeps = {},
): CodexLogGuardLockOutcome<T> {
  let databasePath: string;
  try {
    databasePath = deps.resolveDatabasePath?.(canonicalCodexHome, canonicalLogsDbPath)
      ?? resolveLogGuardLockDatabase(canonicalCodexHome, canonicalLogsDbPath);
  } catch (error) {
    if (error instanceof CodexUserIdentityRefusal) {
      return { kind: "unavailable", reason: "unsafe-path" };
    }
    return { kind: "unavailable", reason: "database" };
  }

  let database: Database | undefined;
  let transactionOpen = false;
  try {
    let absent = false;
    try {
      if (!lockFileIsSafe(databasePath, false)) {
        return { kind: "unavailable", reason: "unsafe-path" };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
      absent = true;
    }

    database = new Database(databasePath, { create: true });
    if (absent) {
      try { chmodSync(databasePath, 0o600); } catch { /* Windows permissions are enforced by the trusted runtime root. */ }
    }
    if (!lockFileIsSafe(databasePath, true)) {
      return { kind: "unavailable", reason: "unsafe-path" };
    }

    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    transactionOpen = true;
    const value = work();
    database.exec("COMMIT");
    transactionOpen = false;
    return { kind: "completed", value };
  } catch (error) {
    if (transactionOpen) {
      try { database?.exec("ROLLBACK"); } catch { /* close releases it */ }
    }
    if (isSqliteBusy(error)) return { kind: "unavailable", reason: "busy" };
    throw error;
  } finally {
    try { database?.close(); } catch { /* acquisition already settled */ }
  }
}
