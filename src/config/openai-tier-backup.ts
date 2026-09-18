import { chmodSync, constants as fsConstants, copyFileSync, existsSync, linkSync, readFileSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { getConfigPath } from "./paths";
import { isMissingPathError, nextAtomicTempSequence } from "./atomic-write";
import { forgetEphemeralSecretPath, hardenSecretPath } from "../lib/windows-secret-acl";

export class OpenAiTierBackupCleanupError extends Error {
  constructor() { super("OpenAI tier backup temporary cleanup failed"); this.name = "OpenAiTierBackupCleanupError"; }
}

export class OpenAiTierBackupRollbackError extends Error {
  constructor() { super("OpenAI tier backup rollback failed"); this.name = "OpenAiTierBackupRollbackError"; }
}

export class OpenAiTierBackupCollisionError extends Error {
  readonly configPath?: string;
  constructor(configPath?: string) {
    super("Existing OpenAI tier backup differs from the current config");
    this.name = "OpenAiTierBackupCollisionError";
    this.configPath = configPath;
  }
}

export class OpenAiTierRollbackPreserveError extends Error {
  readonly code?: "missing" | "not-rollback" | "mismatch" | "exhausted";
  constructor(message: string, options?: ErrorOptions & { code?: OpenAiTierRollbackPreserveError["code"] }) {
    super(message, options);
    this.name = "OpenAiTierRollbackPreserveError";
    this.code = options?.code;
  }
}

export class OpenAiTierBackupSecretResidualError extends Error {
  constructor(readonly tempPath: string, options?: ErrorOptions) {
    super("OpenAI tier backup could not scrub or remove a secret-bearing temporary file", options);
    this.name = "OpenAiTierBackupSecretResidualError";
  }
}

export interface OpenAiTierBackupIO {
  exists(path: string): boolean;
  read(path: string): Uint8Array;
  createExclusive(path: string): void;
  write(path: string, bytes: Uint8Array): void;
  harden(path: string): void;
  publishNoReplace(temp: string, backup: string): void;
  truncate(path: string): void;
  unlink(path: string): void;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

/**
 * Classify an existing `.pre-openai-tiers-v2.bak` snapshot.
 *
 * - `"stale"`: unparseable JSON (not written by us / truncated) or already a
 *   post-migration (tier v2) snapshot — safe to delete or replace.
 * - `"rollback"`: parses as a valid pre-migration (v1) config — a
 *   user-intentional rollback point that must never be silently destroyed.
 *
 * Shared by the startup migration backup path and `ocx init` cleanup so both
 * apply the same preservation policy (issue #257 / sol review 260722).
 */
export function classifyOpenAiTierBackup(backupBytes: Uint8Array): "stale" | "rollback" {
  try {
    // Use Buffer.from to ensure proper UTF-8 decoding from Uint8Array/Buffer.
    const parsed = JSON.parse(Buffer.from(backupBytes).toString("utf8")) as Record<string, unknown>;
    return parsed.openaiProviderTierVersion === 2 ? "stale" : "rollback";
  } catch {
    // Unparseable: not a config file we created, treat as stale.
    return "stale";
  }
}

export function backupConfigBeforeOpenAiTierMigration(
  configPath = getConfigPath(),
  io: OpenAiTierBackupIO = {
    exists: existsSync,
    read: target => readFileSync(target),
    createExclusive: target => { writeFileSync(target, new Uint8Array(), { flag: "wx", mode: 0o600 }); },
    write: (target, bytes) => writeFileSync(target, bytes),
    harden: target => {
      try { chmodSync(target, 0o600); } catch { /* platform may ignore chmod */ }
      // Soft-fail: a wedged/failed icacls on CI temp volumes must not abort
      // startServer mid-suite (timeout + EBUSY cascade on shared TEST_DIR).
      // chmod above still applies; live credential writes keep required:true.
      if (process.platform === "win32") hardenSecretPath(target, { required: false });
    },
    publishNoReplace: (temp, backup) => linkSync(temp, backup),
    truncate: target => truncateSync(target, 0),
    unlink: unlinkSync,
  },
): "absent" | "created" | "reused" {
  const source = configPath;
  if (!io.exists(source)) return "absent";
  const original = io.read(source);
  // v2 snapshot path. The historical `.pre-openai-tiers-v1.bak` is read only by restore
  // docs/fixtures and is never reused or overwritten as the v2 snapshot.
  const backup = `${source}.pre-openai-tiers-v2.bak`;
  if (io.exists(backup)) {
    if (!sameBytes(original, io.read(backup))) {
      // The backup differs from the current config. Only treat it as stale when it is
      // clearly not a user-intentional rollback point:
      //   - unparseable JSON: written by a different tool or truncated
      //   - already at tier version 2: the backup is from a post-migration config (e.g.
      //     ocx init wrote a fresh v2 config, making the old backup obsolete)
      // A backup that parses as a valid pre-migration (v1) config is kept as-is and
      // we throw a collision error, because silently replacing a user-created rollback
      // point would be surprising and potentially destructive.
      const backupBytes = io.read(backup);
      if (classifyOpenAiTierBackup(backupBytes) === "rollback") {
        throw new OpenAiTierBackupCollisionError(source);
      }
      console.warn("[openai-provider-migration] Replacing stale pre-migration backup (post-migration config was rewritten since last migration).");
      io.unlink(backup);
    } else {
      return "reused";
    }
  }
  const temp = `${backup}.ocx.${process.pid}.${nextAtomicTempSequence()}.tmp`;
  let published = false;
  let cleanupAttempted = false;

  const scrubUnpublishedTemp = (): void => {
    cleanupAttempted = true;
    let scrubbed = false;
    try {
      io.truncate(temp);
      scrubbed = true;
    } catch (error) {
      if (isMissingPathError(error)) scrubbed = true;
      else {
        try { io.write(temp, new Uint8Array()); scrubbed = true; } catch { /* removal may still succeed */ }
      }
    }
    let removed = false;
    try {
      io.unlink(temp);
      removed = true;
    } catch (error) {
      if (isMissingPathError(error)) {
        removed = true;
      }
      else {
        try { io.unlink(temp); removed = true; }
        catch (retryError) {
          if (isMissingPathError(retryError)) {
            removed = true;
          }
        }
      }
    }
    if (removed) forgetEphemeralSecretPath(temp);
    if (!removed && !scrubbed) throw new OpenAiTierBackupSecretResidualError(temp);
    if (!removed) throw new OpenAiTierBackupCleanupError();
  };

  try {
    io.createExclusive(temp);
    io.write(temp, original);
    io.harden(temp);
    try {
      io.publishNoReplace(temp, backup);
    } catch (cause) {
      if (!isAlreadyExistsError(cause)) throw cause;
      const winner = io.read(backup);
      if (!sameBytes(original, winner)) throw new OpenAiTierBackupCollisionError(source);
      scrubUnpublishedTemp();
      return "reused";
    }
    published = true;
    try {
      io.unlink(temp);
      forgetEphemeralSecretPath(temp);
    } catch (firstError) {
      if (isMissingPathError(firstError)) {
        forgetEphemeralSecretPath(temp);
      } else try {
        io.unlink(temp);
        forgetEphemeralSecretPath(temp);
      } catch (secondError) {
        if (isMissingPathError(secondError)) {
          forgetEphemeralSecretPath(temp);
          return "created";
        }
        // temp and backup are hard links to the same inode. Roll back the backup
        // link before any truncation so the downgrade snapshot is never zeroed.
        try { io.unlink(backup); } catch { throw new OpenAiTierBackupRollbackError(); }
        published = false;
        scrubUnpublishedTemp();
        throw new OpenAiTierBackupCleanupError();
      }
    }
    return "created";
  } catch (cause) {
    if (!published && !cleanupAttempted) {
      scrubUnpublishedTemp();
    }
    throw cause;
  }
}

export interface OpenAiTierRollbackPreserveIO {
  exists(path: string): boolean;
  read(path: string): Uint8Array;
  copyExclusive(source: string, destination: string): void;
  unlink(path: string): void;
}

const DEFAULT_ROLLBACK_PRESERVE_IO: OpenAiTierRollbackPreserveIO = {
  exists: existsSync,
  read: target => readFileSync(target),
  copyExclusive: (source, destination) => {
    copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
  },
  unlink: unlinkSync,
};

const OPENAI_TIER_ROLLBACK_PRESERVE_ATTEMPTS = 16;

/**
 * Copy a rollback-classified `.pre-openai-tiers-v2.bak` to a unique
 * `.pre-openai-tiers-v1-rollback.<timestamp>[suffix].bak` path, then unlink the
 * blocking v2 name. The original bytes are copied with no-replace publication;
 * the v2 path is removed only after the copy is verified. Shared by startup
 * migration recovery and `ocx init` cleanup so the two paths cannot drift.
 */
export function preserveOpenAiTierRollbackSnapshot(
  configPath = getConfigPath(),
  io: OpenAiTierRollbackPreserveIO = DEFAULT_ROLLBACK_PRESERVE_IO,
): string {
  const backup = `${configPath}.pre-openai-tiers-v2.bak`;
  if (!io.exists(backup)) {
    throw new OpenAiTierRollbackPreserveError("OpenAI tier rollback backup is missing", { code: "missing" });
  }
  const original = io.read(backup);
  if (classifyOpenAiTierBackup(original) !== "rollback") {
    throw new OpenAiTierRollbackPreserveError("OpenAI tier backup is not a rollback snapshot", { code: "not-rollback" });
  }
  for (let attempt = 0; attempt < OPENAI_TIER_ROLLBACK_PRESERVE_ATTEMPTS; attempt++) {
    const preserved = `${configPath}.pre-openai-tiers-v1-rollback.${Date.now()}${attempt ? `-${attempt}` : ""}.bak`;
    try {
      io.copyExclusive(backup, preserved);
    } catch (error) {
      if (isAlreadyExistsError(error)) continue;
      throw error;
    }
    let copied: Uint8Array;
    try {
      copied = io.read(preserved);
    } catch (error) {
      throw new OpenAiTierRollbackPreserveError("Failed to read preserved rollback snapshot", { cause: error, code: "mismatch" });
    }
    if (!sameBytes(original, copied)) {
      try { io.unlink(preserved); } catch { /* keep the original backup; incomplete copy is best-effort */ }
      throw new OpenAiTierRollbackPreserveError("Preserved rollback snapshot does not match source bytes", { code: "mismatch" });
    }
    io.unlink(backup);
    return preserved;
  }
  throw new OpenAiTierRollbackPreserveError("Unable to find a unique rollback snapshot path", { code: "exhausted" });
}

