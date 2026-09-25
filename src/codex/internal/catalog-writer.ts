import { chmodSync, linkSync, mkdirSync, readFileSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  AtomicWriteResidualTempError,
  AtomicWriteSecretResidualError,
  atomicWriteFile,
  getConfigDir,
  resolveWriteTarget,
  type AtomicWriteIO,
} from "../../config";
import {
  assertCatalogWritePermit,
  type CatalogWritePermit,
} from "../catalog-write-serialization";
import {
  forgetEphemeralSecretPath,
  hardenSecretPath,
} from "../../lib/windows-secret-acl";
import { resetCodexAppServerCatalogStateCache } from "../app-server-processes";
import { recordOwnedConfigPath } from "../../lib/config-ownership";

export interface PreparedCatalogFileWrite {
  readonly path: string;
  readonly content: string;
}

export type CatalogBackupPublication = "written" | "preserved";

export interface CatalogBackupWriteIO {
  readonly resolveTarget: (path: string) => string;
  readonly write: (path: string, content: string) => void;
  readonly harden: (path: string) => void;
  /** Must fail with EEXIST rather than replacing an existing destination. */
  readonly publishNoReplace: (source: string, destination: string) => void;
  readonly truncate: (path: string) => void;
  readonly unlink: (path: string) => void;
}

let backupTempSequence = 0;

/**
 * Do the prepared bytes differ from what is already on disk at `prepared.path`?
 *
 * The single no-op rule for both files the catalog layer owns — the active catalog
 * and Codex's models cache — so the two writers cannot drift apart. Every
 * mtime-keyed reader has to treat a rewrite as a change: the app-server staleness
 * classifier (#857) compares a file's mtime against each running Codex's start
 * time, so rewriting identical bytes marks every already-running Codex as stale
 * even though nothing changed. #1459 established this rule for the catalog; the
 * cache is the second writer that has to apply it, because
 * `refreshCodexModelCatalog` reports `cacheSynced` straight into the startup
 * warning in `handleStart`.
 *
 * Deliberately a Buffer rather than a decoded string: `readFileSync(path, "utf8")`
 * substitutes U+FFFD for every invalid byte, so a file holding a raw 0x80 decodes
 * equal to prepared content holding a legitimately encoded U+FFFD. Comparing
 * decoded strings would then classify a malformed file as identical, skip the
 * atomic repair write, and leave the corruption on disk.
 *
 * An unreadable or absent file reports "differs", so the caller performs the real
 * write; that also converges a file that does not exist yet.
 */
export function preparedBytesDifferFromDisk(prepared: PreparedCatalogFileWrite): boolean {
  let onDisk: Buffer;
  try {
    onDisk = readFileSync(prepared.path);
  } catch {
    return true;
  }
  return !onDisk.equals(Buffer.from(prepared.content, "utf8"));
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isExistingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function defaultBackupWriteIO(destinationPath: string): CatalogBackupWriteIO {
  return {
    resolveTarget: resolveWriteTarget,
    write: (path, content) => writeFileSync(path, content, { encoding: "utf8", mode: 0o600 }),
    harden: path => {
      try { chmodSync(path, 0o600); } catch { /* platform may ignore chmod */ }
      if (process.platform === "win32") {
        hardenSecretPath(path, { required: true, timeoutMemoKey: destinationPath });
      }
    },
    publishNoReplace: linkSync,
    truncate: path => truncateSync(path, 0),
    unlink: unlinkSync,
  };
}

function removePublishedTemp(tempPath: string, io: CatalogBackupWriteIO): void {
  try {
    io.unlink(tempPath);
    forgetEphemeralSecretPath(tempPath);
    return;
  } catch (firstError) {
    if (isMissingPathError(firstError)) {
      forgetEphemeralSecretPath(tempPath);
      return;
    }
    try {
      io.unlink(tempPath);
      forgetEphemeralSecretPath(tempPath);
      return;
    } catch (retryError) {
      if (isMissingPathError(retryError)) {
        forgetEphemeralSecretPath(tempPath);
        return;
      }
      throw new AtomicWriteResidualTempError(tempPath, true, { cause: retryError });
    }
  }
}

function scrubAndRemoveUnpublishedTemp(
  tempPath: string,
  hardened: boolean,
  io: CatalogBackupWriteIO,
  cause: unknown,
): void {
  let scrubbed = false;
  try {
    io.truncate(tempPath);
    scrubbed = true;
  } catch (error) {
    if (isMissingPathError(error)) scrubbed = true;
    else {
      try {
        io.write(tempPath, "");
        scrubbed = true;
      } catch { /* removal may still succeed */ }
    }
  }

  let removed = false;
  try {
    io.unlink(tempPath);
    removed = true;
  } catch (error) {
    if (isMissingPathError(error)) removed = true;
    else {
      try {
        io.unlink(tempPath);
        removed = true;
      } catch (retryError) {
        if (isMissingPathError(retryError)) removed = true;
      }
    }
  }

  if (!removed && !scrubbed) {
    throw new AtomicWriteSecretResidualError(tempPath, { cause });
  }
  if (!removed && !hardened) {
    try {
      io.harden(tempPath);
      hardened = true;
    } catch { /* zero-byte residual is reported honestly */ }
  }
  if (removed) forgetEphemeralSecretPath(tempPath);
  if (!removed) throw new AtomicWriteResidualTempError(tempPath, hardened, { cause });
}

function publishCatalogBackup(
  prepared: PreparedCatalogFileWrite,
  suppliedIo?: CatalogBackupWriteIO,
  onPublished?: () => void,
): CatalogBackupPublication {
  const io = suppliedIo ?? defaultBackupWriteIO(prepared.path);
  const target = io.resolveTarget(prepared.path);
  if (!suppliedIo) mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const tempPath = `${target}.ocx.${process.pid}.backup.${++backupTempSequence}.tmp`;
  let hardened = false;

  try {
    io.write(tempPath, prepared.content);
    io.harden(tempPath);
    hardened = true;
    io.publishNoReplace(tempPath, target);
  } catch (error) {
    scrubAndRemoveUnpublishedTemp(tempPath, hardened, io, error);
    if (isExistingPathError(error)) return "preserved";
    throw error;
  }

  try {
    // Publication already succeeded; cleanup failure must not erase that ownership.
    onPublished?.();
  } finally {
    removePublishedTemp(tempPath, io);
  }
  return "written";
}

/** Replace the active catalog with the caller's already-prepared bytes. */
export function replaceActiveCodexCatalog(
  permit: CatalogWritePermit,
  owningCodexHome: string,
  prepared: PreparedCatalogFileWrite,
  io?: AtomicWriteIO,
): void {
  assertCatalogWritePermit(permit, owningCodexHome);
  atomicWriteFile(prepared.path, prepared.content, io);
  resetCodexAppServerCatalogStateCache();
}

/** Atomically publish the catalog-path-keyed immutable backup without clobbering. */
export function publishHashedCodexCatalogBackup(
  permit: CatalogWritePermit,
  owningCodexHome: string,
  prepared: PreparedCatalogFileWrite,
  io?: CatalogBackupWriteIO,
): CatalogBackupPublication {
  assertCatalogWritePermit(permit, owningCodexHome);
  return publishCatalogBackup(prepared, io, io ? undefined : () => {
    // Called only after a new no-replace publication, never for preserved winners.
    recordOwnedConfigPath(getConfigDir(), prepared.path);
  });
}

/** Atomically publish the legacy immutable backup without clobbering. */
export function publishLegacyCodexCatalogBackup(
  permit: CatalogWritePermit,
  owningCodexHome: string,
  prepared: PreparedCatalogFileWrite,
  io?: CatalogBackupWriteIO,
): CatalogBackupPublication {
  assertCatalogWritePermit(permit, owningCodexHome);
  return publishCatalogBackup(prepared, io);
}

/** Replace Codex's models cache with the caller's already-prepared bytes. */
export function replaceCodexModelsCache(
  permit: CatalogWritePermit,
  owningCodexHome: string,
  prepared: PreparedCatalogFileWrite,
  io?: AtomicWriteIO,
): void {
  assertCatalogWritePermit(permit, owningCodexHome);
  atomicWriteFile(prepared.path, prepared.content, io);
  resetCodexAppServerCatalogStateCache();
}
