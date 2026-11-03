/**
 * The private build file of a worker rebuild (#6990).
 *
 * The worker writes the whole index into `<index>.rebuild-<pid>-<n>` next to
 * the published file; the serving thread swaps it in only once it is complete,
 * so no reader ever sees a partial index.
 */

import { Database } from "bun:sqlite";
import { readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { UsageLogRevision } from "../../usage/log";
import { ingestSourceTail, recordSourceMeta, resetAndCreateSchema, setMeta } from "./ingest";
import { HISTORY_META_KEYS } from "./schema";

const BUILD_SIDE_FILES = ["", "-journal", "-wal", "-shm"] as const;

export function buildFilePath(indexPath: string, pid: number, sequence: number): string {
  return `${indexPath}.rebuild-${pid}-${sequence}`;
}

export function removeBuildFiles(buildPath: string): void {
  for (const suffix of BUILD_SIDE_FILES) {
    try { rmSync(`${buildPath}${suffix}`, { force: true }); } catch { /* best effort; swept on a later build */ }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists under another user. Anything but ESRCH is treated as alive.
    return (error as { code?: unknown } | null)?.code !== "ESRCH";
  }
}

/**
 * Remove build files a crashed process left beside the index. A build of this
 * process, or of another live process, is left alone; this process removes
 * its own builds once their worker has exited.
 */
export function removeAbandonedBuilds(indexPath: string): number {
  const prefix = `${basename(indexPath)}.rebuild-`;
  let names: string[];
  try {
    names = readdirSync(dirname(indexPath));
  } catch {
    return 0;
  }
  const abandoned = new Set<string>();
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const match = /^(\d+)-(\d+)/.exec(name.slice(prefix.length));
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || processIsAlive(pid)) continue;
    abandoned.add(`${prefix}${match[1]}-${match[2]}`);
  }
  for (const name of abandoned) removeBuildFiles(join(dirname(indexPath), name));
  return abandoned.size;
}

/**
 * Build a complete index of the ledger snapshot `revision` describes into
 * `buildPath`, leave it in WAL mode and close it. Returns the rows ingested.
 * A private build needs no crash durability: an interrupted one is discarded.
 */
export function buildIndexFile(buildPath: string, reason: string, revision: UsageLogRevision): number {
  removeBuildFiles(buildPath);
  const build = new Database(buildPath, { create: true, readwrite: true });
  try {
    build.exec("PRAGMA journal_mode = MEMORY");
    build.exec("PRAGMA synchronous = OFF");
    resetAndCreateSchema(build);
    setMeta(build, HISTORY_META_KEYS.lastError, reason);
    recordSourceMeta(build, revision);
    const inserted = ingestSourceTail(build, revision.path, 0, {
      expected: revision,
      endOffset: Number(revision.size),
    });
    // Validate before publication while still off the serving thread. The
    // published handle can then be trusted until its periodic worker check.
    const check = build.query("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (check?.quick_check !== "ok") {
      throw Object.assign(new Error("rebuilt history index failed integrity check"), { code: "SQLITE_CORRUPT" });
    }
    // The serving thread opens the published file in WAL mode; switching here
    // keeps that first open from rewriting the database header.
    build.exec("PRAGMA journal_mode = WAL");
    build.close();
    return inserted;
  } catch (error) {
    try { build.close(); } catch { /* already unusable */ }
    removeBuildFiles(buildPath);
    throw error;
  }
}
