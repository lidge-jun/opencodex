import { readdirSync, statSync } from "node:fs";
import { readdir, stat as statAsync } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Database, constants } from "bun:sqlite";
import { resolveCodexHomeDir } from "../codex/home";
import { TRASH_DIR } from "./cleanup";

// SQLITE_OPEN_READONLY alone is not filesystem-read-only for a WAL-mode DB: Bun's
// `{ readonly: true }` can still materialize *.sqlite-wal/-shm sidecars the first time a
// checkpointed WAL database (no live sidecars yet) is opened and queried. `immutable=1`
// (via a file: URI, which requires the SQLITE_OPEN_URI flag) tells SQLite the file will
// never change for this connection's lifetime, so it skips WAL/shm entirely — the
// tradeoff is reading the last-checkpointed snapshot instead of blocking on a live writer,
// which is the right tradeoff for a passive diagnostics scan that must never write.
const IMMUTABLE_READONLY_FLAGS = constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI;

/**
 * Read-only CODEX_HOME storage scanner — Phase 1 of the Storage page epic
 * (devlog/_fin/500_storage-page-session-cleanup). Pure measurement: sizes via
 * fs.stat walks, DB row counts via immutable readonly opens that degrade to
 * null on lock/corruption. Performs zero writes under CODEX_HOME.
 */

export type StorageBucketKey =
  | "sessions"
  | "archived_sessions"
  | "logs_db"
  | "state_db"
  | "attachments"
  | "deletion_manifests"
  | "other";

export interface StorageLargestEntry {
  /** Path relative to CODEX_HOME, forward-slash separated on every platform. */
  path: string;
  bytes: number;
}

export interface StorageBucket {
  key: StorageBucketKey;
  label: string;
  bytes: number;
  fileCount: number;
  /** Epoch ms of the oldest/newest file mtime; absent for empty buckets. */
  oldest?: number;
  newest?: number;
  largest?: StorageLargestEntry[];
  /** sqlite buckets only: row count from the newest versioned DB, null when locked/unreadable. */
  rows?: number | null;
}

export interface StorageReport {
  codexHome: string;
  generatedAt: number;
  total: { bytes: number; fileCount: number };
  buckets: StorageBucket[];
}

const LARGEST_CAP = 5;

const BUCKET_LABELS: Record<StorageBucketKey, string> = {
  sessions: "Active sessions",
  archived_sessions: "Archived sessions",
  logs_db: "Logs database",
  state_db: "State database",
  attachments: "Attachments",
  deletion_manifests: "Deletion manifests",
  other: "Other",
};

/** Dirs under CODEX_HOME that map to a dedicated bucket; anything else is "other". */
const DIR_BUCKETS: Record<string, StorageBucketKey> = {
  sessions: "sessions",
  archived_sessions: "archived_sessions",
  attachments: "attachments",
  deletion_manifests: "deletion_manifests",
};

// state_5.sqlite / logs_2.sqlite carry a version suffix and live WAL/SHM siblings.
const STATE_DB_FILE = /^state_(\d+)\.sqlite(-wal|-shm)?$/;
const LOGS_DB_FILE = /^logs_(\d+)\.sqlite(-wal|-shm)?$/;

interface FileEntry {
  relPath: string;
  bytes: number;
  mtimeMs: number;
}

/** Recursive fs.stat walk. Unreadable entries (races, broken symlinks) are skipped, never fatal. */
function walkFiles(dir: string, relPrefix: string, out: FileEntry[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    try {
      if (entry.isDirectory()) {
        walkFiles(full, relPath, out);
      } else if (entry.isFile()) {
        const stat = statSync(full);
        out.push({ relPath, bytes: stat.size, mtimeMs: stat.mtimeMs });
      }
    } catch {
      /* entry vanished mid-scan — diagnostics tolerate racy trees */
    }
  }
}

/** Upper bound on concurrent readdir/stat calls within one async scan. */
const SCAN_FS_CONCURRENCY = 64;

type FsLimit = <T>(op: () => Promise<T>) => Promise<T>;

/**
 * FIFO limiter for filesystem calls. A finishing call hands its slot straight to the next
 * waiter, so the bound holds exactly. Only leaf fs calls take a slot: a directory walk
 * never holds one while awaiting its children, so recursion cannot deadlock the pool.
 */
function createFsLimit(max: number): FsLimit {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(op: () => Promise<T>): Promise<T> => {
    if (active < max) active += 1;
    else await new Promise<void>(resolve => waiting.push(resolve));
    try {
      return await op();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

/** Entries started together at one directory level of an async scan. */
const SCAN_BATCH_SIZE = 256;

/**
 * Map `items` through `fn` a batch at a time, keeping input order. A directory with tens of
 * thousands of entries then has at most one batch of pending tasks at its level, instead of
 * one promise per entry queued behind the fs limiter.
 */
async function mapInBatches<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += SCAN_BATCH_SIZE) {
    const batch = await Promise.all(items.slice(start, start + SCAN_BATCH_SIZE).map(fn));
    for (const result of batch) results.push(result);
  }
  return results;
}

/**
 * Async twin of {@link walkFiles}: same skip rules, and entries come back in readdir
 * order so the report (including `largest` tie order) matches the synchronous scan.
 */
async function walkFilesAsync(dir: string, relPrefix: string, limit: FsLimit): Promise<FileEntry[]> {
  let entries;
  try {
    entries = await limit(() => readdir(dir, { withFileTypes: true }));
  } catch {
    return [];
  }
  // Bun can settle small async fs calls on the microtask queue alone, so a walk of cached
  // directories would otherwise finish without ever giving the event loop a turn. One timer
  // turn per directory keeps request handling live during a large scan.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  const parts = await mapInBatches(entries, async (entry): Promise<FileEntry[]> => {
    const full = join(dir, entry.name);
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    try {
      if (entry.isDirectory()) return await walkFilesAsync(full, relPath, limit);
      if (entry.isFile()) {
        const stat = await limit(() => statAsync(full));
        return [{ relPath, bytes: stat.size, mtimeMs: stat.mtimeMs }];
      }
    } catch {
      /* entry vanished mid-scan — diagnostics tolerate racy trees */
    }
    return [];
  });
  return parts.flat();
}

function buildBucket(key: StorageBucketKey, files: FileEntry[]): StorageBucket {
  const bucket: StorageBucket = {
    key,
    label: BUCKET_LABELS[key],
    bytes: 0,
    fileCount: files.length,
  };
  for (const file of files) {
    bucket.bytes += file.bytes;
    if (bucket.oldest === undefined || file.mtimeMs < bucket.oldest) bucket.oldest = file.mtimeMs;
    if (bucket.newest === undefined || file.mtimeMs > bucket.newest) bucket.newest = file.mtimeMs;
  }
  if (files.length > 0) {
    bucket.largest = [...files]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, LARGEST_CAP)
      .map(f => ({ path: f.relPath, bytes: f.bytes }));
  }
  return bucket;
}

/**
 * Row count via an immutable readonly open — guarantees zero writes under CODEX_HOME even
 * for a checkpointed WAL-mode DB with no sidecars yet. Any error (corruption, a file that
 * vanished mid-scan, a future schema change) degrades to null — "unknown", never a crash.
 */
function countRowsReadonly(dbPath: string, table: string): number | null {
  try {
    // pathToFileURL percent-encodes reserved characters (space, #, ?, %) that a naive
    // `file:${dbPath}` concatenation would misparse as a URI fragment/query/escape.
    const uri = `${pathToFileURL(dbPath).href}?immutable=1`;
    const db = new Database(uri, IMMUTABLE_READONLY_FLAGS);
    try {
      const row = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${table}"`).get();
      return row?.n ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Newest versioned DB main file (e.g. state_5.sqlite over state_4.sqlite), or null. */
function newestVersionedDb(names: string[], pattern: RegExp): string | null {
  let best: string | null = null;
  let bestVersion = -1;
  for (const name of names) {
    const match = name.match(pattern);
    if (!match || match[2]) continue; // -wal/-shm siblings never win
    const version = Number(match[1]);
    if (version > bestVersion) {
      bestVersion = version;
      best = name;
    }
  }
  return best;
}

function emptyFiles(): Record<StorageBucketKey, FileEntry[]> {
  return {
    sessions: [],
    archived_sessions: [],
    logs_db: [],
    state_db: [],
    attachments: [],
    deletion_manifests: [],
    other: [],
  };
}

/** A missing home is a normal fresh-machine state; any other readdir failure is rethrown. */
function rootReadFailure(error: unknown): string[] {
  // A missing home is a normal fresh-machine state — report zeros. Anything else
  // (e.g. ENOTDIR: CODEX_HOME points at a file) is a broken setup the caller
  // must surface as a scan failure, not silently render as an empty home.
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") throw error;
  return [];
}

function rootFileBucket(name: string): StorageBucketKey {
  return STATE_DB_FILE.test(name) ? "state_db" : LOGS_DB_FILE.test(name) ? "logs_db" : "other";
}

function finishReport(
  codexHome: string,
  rootNames: string[],
  files: Record<StorageBucketKey, FileEntry[]>,
): StorageReport {
  const buckets = (Object.keys(files) as StorageBucketKey[]).map(key => buildBucket(key, files[key]));

  const stateDbName = newestVersionedDb(rootNames, STATE_DB_FILE);
  const stateBucket = buckets.find(b => b.key === "state_db");
  if (stateBucket && stateBucket.fileCount > 0) {
    stateBucket.rows = stateDbName ? countRowsReadonly(join(codexHome, stateDbName), "threads") : null;
  }
  const logsDbName = newestVersionedDb(rootNames, LOGS_DB_FILE);
  const logsBucket = buckets.find(b => b.key === "logs_db");
  if (logsBucket && logsBucket.fileCount > 0) {
    logsBucket.rows = logsDbName ? countRowsReadonly(join(codexHome, logsDbName), "logs") : null;
  }

  let totalBytes = 0;
  let totalFiles = 0;
  for (const bucket of buckets) {
    totalBytes += bucket.bytes;
    totalFiles += bucket.fileCount;
  }

  return {
    codexHome,
    generatedAt: Date.now(),
    total: { bytes: totalBytes, fileCount: totalFiles },
    buckets,
  };
}

export function scanStorage(codexHome: string = resolveCodexHomeDir()): StorageReport {
  const files = emptyFiles();

  let rootNames: string[] = [];
  try {
    rootNames = readdirSync(codexHome);
  } catch (error) {
    rootNames = rootReadFailure(error);
  }

  for (const name of rootNames) {
    const full = join(codexHome, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      // Quarantine trash (Phase 2) must not inflate "other" or totals.
      if (name === TRASH_DIR) continue;
      walkFiles(full, name, files[DIR_BUCKETS[name] ?? "other"]);
    } else if (stat.isFile()) {
      files[rootFileBucket(name)].push({ relPath: name, bytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  }

  return finishReport(codexHome, rootNames, files);
}

/**
 * Same report as {@link scanStorage}, but the tree walk uses async fs calls so the server's
 * event loop keeps serving while it runs. The synchronous walk measured ~3.7s for a
 * 40k-file / 7.5GB CODEX_HOME on Windows, during which every listener (proxy traffic
 * included) stalled each time the Storage page loaded. The two sqlite row counts stay
 * synchronous: immutable readonly opens measured ~0.1s on the same home.
 */
export async function scanStorageAsync(codexHome: string = resolveCodexHomeDir()): Promise<StorageReport> {
  const files = emptyFiles();
  const limit = createFsLimit(SCAN_FS_CONCURRENCY);

  let rootNames: string[] = [];
  try {
    rootNames = await readdir(codexHome);
  } catch (error) {
    rootNames = rootReadFailure(error);
  }

  const roots = await mapInBatches(rootNames, async name => {
    const full = join(codexHome, name);
    try {
      return { name, full, stat: await limit(() => statAsync(full)) };
    } catch {
      return null;
    }
  });
  const walks = await mapInBatches(roots, async root => {
    if (!root) return;
    if (root.stat.isDirectory()) {
      // Quarantine trash (Phase 2) must not inflate "other" or totals.
      if (root.name === TRASH_DIR) return;
      return { key: DIR_BUCKETS[root.name] ?? "other", entries: await walkFilesAsync(root.full, root.name, limit) };
    }
    if (root.stat.isFile()) {
      return {
        key: rootFileBucket(root.name),
        entries: [{ relPath: root.name, bytes: root.stat.size, mtimeMs: root.stat.mtimeMs }],
      };
    }
  });
  // Appended in root order so bucket contents match the synchronous scan. One entry at a
  // time: spreading a large bucket into push() can exceed the engine's argument limit.
  for (const walk of walks) {
    if (!walk) continue;
    const bucket = files[walk.key];
    for (const entry of walk.entries) bucket.push(entry);
  }

  return finishReport(codexHome, rootNames, files);
}
