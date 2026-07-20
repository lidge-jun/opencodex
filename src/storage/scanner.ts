import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { resolveCodexHomeDir } from "../codex/home";

/**
 * Read-only CODEX_HOME storage scanner — Phase 1 of the Storage page epic
 * (devlog/_plan/500_storage-page-session-cleanup). Pure measurement: sizes via
 * fs.stat walks, DB row counts via short-timeout readonly opens that degrade to
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
 * Row count via a lock-safe readonly open (the same secondary-reader contract as
 * codex/history-provider.ts): short busy timeout, and any lock/corruption/schema
 * error degrades to null — "unknown", never a crash and never a write.
 */
function countRowsReadonly(dbPath: string, table: string): number | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 100");
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

export function scanStorage(codexHome: string = resolveCodexHomeDir()): StorageReport {
  const files: Record<StorageBucketKey, FileEntry[]> = {
    sessions: [],
    archived_sessions: [],
    logs_db: [],
    state_db: [],
    attachments: [],
    deletion_manifests: [],
    other: [],
  };

  let rootNames: string[] = [];
  try {
    rootNames = readdirSync(codexHome);
  } catch (error) {
    // A missing home is a normal fresh-machine state — report zeros. Anything else
    // (e.g. ENOTDIR: CODEX_HOME points at a file) is a broken setup the caller
    // must surface as a scan failure, not silently render as an empty home.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
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
      walkFiles(full, name, files[DIR_BUCKETS[name] ?? "other"]);
    } else if (stat.isFile()) {
      const key: StorageBucketKey = STATE_DB_FILE.test(name) ? "state_db" : LOGS_DB_FILE.test(name) ? "logs_db" : "other";
      files[key].push({ relPath: name, bytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  }

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
