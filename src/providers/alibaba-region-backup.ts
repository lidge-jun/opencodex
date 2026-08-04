import { copyFileSync, existsSync, linkSync, readFileSync, rmSync } from "node:fs";
import { getConfigPath } from "../config";

export interface AlibabaBackupIO {
  exists: (path: string) => boolean;
  read: (path: string) => Buffer;
  copy: (source: string, destination: string) => void;
  /** Publish with no-replace semantics: fails with EEXIST if the destination exists. */
  publishNoReplace: (temp: string, destination: string) => void;
  remove: (path: string) => void;
}

const DEFAULT_IO: AlibabaBackupIO = {
  exists: existsSync,
  read: path => readFileSync(path),
  copy: (source, destination) => copyFileSync(source, destination),
  publishNoReplace: linkSync,
  remove: path => rmSync(path, { force: true }),
};

export class AlibabaBackupIntegrityError extends Error {}

/**
 * Immutable pre-migration snapshot of `config.json`.
 *
 * Written to a temp file first and published by `link`, which fails with EEXIST
 * rather than replacing. Exclusive *creation* alone is not enough: a crash
 * mid-copy can leave a truncated destination that the next run would accept as a
 * valid rollback point. Copy-verify-link means a published snapshot is always a
 * complete one.
 *
 * An existing snapshot is NOT required to equal the current config. Demanding
 * that has a false positive that would brick a working install: a run that
 * created the snapshot and then aborted for an unrelated reason leaves a
 * perfectly valid snapshot, the user then edits `config.json` legitimately, and
 * every subsequent start would throw out of `startServer` and refuse to boot. A
 * safety net must never become the thing that stops the product.
 *
 * So an existing snapshot is reused as-is — it is the earliest one, which is
 * exactly what a rollback point should be. Integrity is carried by publication.
 *
 * Deliberately not built on `backupConfigBeforeOpenAiTierMigration`: that
 * function's stale/rollback classification exists for a repeatable migration and
 * would be wrong here.
 */
export function backupConfigBeforeAlibabaRegionMigration(
  configPath = getConfigPath(),
  io: AlibabaBackupIO = DEFAULT_IO,
): "absent" | "created" | "reused" {
  if (!io.exists(configPath)) return "absent";
  const backup = `${configPath}.pre-alibaba-region-v1.bak`;
  // The earliest snapshot is the most valuable one: it predates every migration
  // this config has been through.
  if (io.exists(backup)) return "reused";

  const source = io.read(configPath);
  const temp = `${backup}.${process.pid}.tmp`;
  try {
    io.copy(configPath, temp);
    // Verify before publishing: a short copy must never become the snapshot.
    if (!io.read(temp).equals(source)) {
      throw new AlibabaBackupIntegrityError(`failed to write a complete backup to ${temp}`);
    }
    io.publishNoReplace(temp, backup);
    return "created";
  } catch (error) {
    // Another process published between our `exists` check and the link. It went
    // through the same copy-verify-link sequence, so it is complete by
    // construction — nothing else writes this filename.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "reused";
    throw error;
  } finally {
    io.remove(temp);
  }
}
