import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { CODEX_HOME } from "./codex-paths";
import { atomicWriteFile, getConfigDir } from "./config";

const STATE_DB_PATH = join(CODEX_HOME, "state_5.sqlite");
const HISTORY_BACKUP_PATH = join(getConfigDir(), "codex-history-backup.json");
const RESUMABLE_SOURCES = ["cli", "vscode"] as const;

type CodexHistoryProvider = "openai" | "opencodex";

export interface CodexHistorySyncResult {
  rows: number;
  files: number;
  ejectedRows?: number;
}

interface ThreadRow {
  id: string;
  rollout_path: string;
  model_provider: string;
  source: string;
  has_user_event: number;
}

interface BackupEntry {
  id: string;
  rolloutPath: string;
  modelProvider: string;
  source: string;
  hasUserEvent: number;
}

interface BackupManifest {
  version: 1;
  entries: Record<string, BackupEntry>;
}

interface NativeRestoreTarget {
  modelProvider: string;
  source: string;
  hasUserEvent: number;
}

function readBackup(path: string): BackupManifest {
  if (!existsSync(path)) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BackupManifest>;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
      return { version: 1, entries: {} };
    }
    return { version: 1, entries: parsed.entries };
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeBackup(path: string, manifest: BackupManifest): void {
  if (Object.keys(manifest.entries).length === 0) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFile(path, JSON.stringify(manifest, null, 2) + "\n");
}

function rememberOriginal(manifest: BackupManifest, row: ThreadRow): void {
  if (manifest.entries[row.id]) return;
  manifest.entries[row.id] = {
    id: row.id,
    rolloutPath: row.rollout_path,
    modelProvider: row.model_provider,
    source: row.source,
    hasUserEvent: Number(row.has_user_event) || 0,
  };
}

function updateSessionMeta(path: string, patch: { provider?: string; source?: string }): boolean {
  if (!path || !existsSync(path)) return false;
  const stat = statSync(path);
  const raw = readFileSync(path, "utf8");
  const newline = raw.indexOf("\n");
  const firstLine = newline === -1 ? raw : raw.slice(0, newline);
  const rest = newline === -1 ? "" : raw.slice(newline);

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return false;
  }

  if (!parsed || typeof parsed !== "object") return false;
  const record = parsed as { type?: unknown; payload?: { model_provider?: unknown; source?: unknown } };
  if (record.type !== "session_meta" || !record.payload || typeof record.payload !== "object") return false;

  let changed = false;
  if (patch.provider !== undefined && record.payload.model_provider !== patch.provider) {
    record.payload.model_provider = patch.provider;
    changed = true;
  }
  if (patch.source !== undefined && record.payload.source !== patch.source) {
    record.payload.source = patch.source;
    changed = true;
  }
  if (!changed) return false;

  writeFileSync(path, `${JSON.stringify(record)}${rest}`, "utf8");
  utimesSync(path, stat.atime, stat.mtime);
  return true;
}

function toNativeRestoreTarget(entry: BackupEntry): NativeRestoreTarget {
  if (entry.modelProvider !== "opencodex") {
    return {
      modelProvider: entry.modelProvider,
      source: entry.source,
      hasUserEvent: entry.hasUserEvent,
    };
  }
  return {
    modelProvider: "openai",
    source: entry.source === "exec" ? "cli" : entry.source,
    hasUserEvent: 1,
  };
}

function ejectRemainingOpencodexHistory(db: Database): { rows: number; files: number } {
  const rows = db
    .query<ThreadRow, []>(`
      SELECT id, rollout_path, model_provider, source, has_user_event
      FROM threads
      WHERE model_provider = 'opencodex'
        AND trim(coalesce(first_user_message, '')) != ''
    `)
    .all();

  let files = 0;
  for (const row of rows) {
    try {
      if (updateSessionMeta(row.rollout_path, {
        provider: "openai",
        source: row.source === "exec" ? "cli" : undefined,
      })) files++;
    } catch {
      /* native restore should continue even if an old rollout is missing */
    }
  }

  const restore = db.transaction(() => {
    const update = db.query(`
      UPDATE threads
      SET model_provider = 'openai',
          source = CASE WHEN source = 'exec' THEN 'cli' ELSE source END,
          has_user_event = 1
      WHERE id = ?
    `);
    for (const row of rows) update.run(row.id);
  });
  restore();
  return { rows: rows.length, files };
}

export function syncCodexHistoryProvider(provider: CodexHistoryProvider, stateDbPath = STATE_DB_PATH, backupPath = HISTORY_BACKUP_PATH): CodexHistorySyncResult {
  if (!existsSync(stateDbPath)) return { rows: 0, files: 0 };
  if (provider === "openai") return restoreCodexHistoryProvider(stateDbPath, backupPath);

  const db = new Database(stateDbPath);
  try {
    const placeholders = RESUMABLE_SOURCES.map(() => "?").join(",");
    const openaiRows = db
      .query<ThreadRow, string[]>(`
        SELECT id, rollout_path, model_provider, source, has_user_event
        FROM threads
        WHERE model_provider = 'openai'
          AND source IN (${placeholders})
      `)
      .all(...RESUMABLE_SOURCES);
    const execRows = db
      .query<ThreadRow, []>(`
        SELECT id, rollout_path, model_provider, source, has_user_event
        FROM threads
        WHERE model_provider = 'opencodex'
          AND source = 'exec'
          AND trim(coalesce(first_user_message, '')) != ''
      `)
      .all();

    const manifest = readBackup(backupPath);
    for (const row of [...openaiRows, ...execRows]) rememberOriginal(manifest, row);
    writeBackup(backupPath, manifest);

    let files = 0;
    for (const row of openaiRows) {
      try {
        if (updateSessionMeta(row.rollout_path, { provider: "opencodex" })) files++;
      } catch {
        /* best-effort; keep DB migration moving even if one old rollout is malformed */
      }
    }
    for (const row of execRows) {
      try {
        if (updateSessionMeta(row.rollout_path, { source: "cli" })) files++;
      } catch {
        /* best-effort; keep DB migration moving even if one old rollout is malformed */
      }
    }

    const update = db.transaction(() => {
      const markUserEvent = db.query(`
        UPDATE threads
        SET has_user_event = 1
        WHERE id = ?
          AND trim(coalesce(first_user_message, '')) != ''
      `);
      for (const row of [...openaiRows, ...execRows]) markUserEvent.run(row.id);
      db.query(`
        UPDATE threads
        SET model_provider = 'opencodex'
        WHERE model_provider = 'openai'
          AND source IN (${placeholders})
      `).run(...RESUMABLE_SOURCES);
      db.query(`
        UPDATE threads
        SET source = 'cli'
        WHERE model_provider = 'opencodex'
          AND source = 'exec'
          AND trim(coalesce(first_user_message, '')) != ''
      `).run();
    });
    update();

    return { rows: openaiRows.length + execRows.length, files };
  } finally {
    db.close();
  }
}

function restoreCodexHistoryProvider(stateDbPath: string, backupPath: string): CodexHistorySyncResult {
  const manifest = readBackup(backupPath);
  const entries = Object.values(manifest.entries);

  const db = new Database(stateDbPath);
  try {
    if (entries.length === 0) {
      const ejected = ejectRemainingOpencodexHistory(db);
      return ejected.rows > 0 ? { rows: 0, files: ejected.files, ejectedRows: ejected.rows } : { rows: 0, files: 0 };
    }

    let files = 0;
    for (const entry of entries) {
      const target = toNativeRestoreTarget(entry);
      try {
        if (updateSessionMeta(entry.rolloutPath, { provider: target.modelProvider, source: target.source })) files++;
      } catch {
        /* best-effort; keep DB restore moving even if one rollout disappeared */
      }
    }

    const restore = db.transaction(() => {
      const update = db.query(`
        UPDATE threads
        SET model_provider = ?,
            source = ?,
            has_user_event = ?
        WHERE id = ?
      `);
      for (const entry of entries) {
        const target = toNativeRestoreTarget(entry);
        update.run(target.modelProvider, target.source, target.hasUserEvent, entry.id);
      }
    });
    restore();
    writeBackup(backupPath, { version: 1, entries: {} });
    const ejected = ejectRemainingOpencodexHistory(db);
    return ejected.rows > 0
      ? { rows: entries.length, files: files + ejected.files, ejectedRows: ejected.rows }
      : { rows: entries.length, files };
  } finally {
    db.close();
  }
}

export function restoreLegacyOpenaiHistory(stateDbPath = STATE_DB_PATH): { rows: number; files: number } {
  if (!existsSync(stateDbPath)) return { rows: 0, files: 0 };
  const db = new Database(stateDbPath);
  try {
    return ejectRemainingOpencodexHistory(db);
  } finally {
    db.close();
  }
}
