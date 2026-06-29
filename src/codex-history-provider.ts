import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { CODEX_HOME } from "./codex-paths";
import { atomicWriteFile, getConfigDir } from "./config";

const STATE_DB_PATH = join(CODEX_HOME, "state_5.sqlite");
function historyBackupPathFor(stateDbPath: string): string {
  const normalized = process.platform === "win32" ? resolve(stateDbPath).toLowerCase() : resolve(stateDbPath);
  const id = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(getConfigDir(), `codex-history-backup-${id}.json`);
}
const HISTORY_BACKUP_PATH = historyBackupPathFor(STATE_DB_PATH);
const RESUMABLE_SOURCES = ["cli", "vscode"] as const;

/**
 * Open the live `state_5.sqlite` the way the Codex app expects a *secondary* writer to behave:
 * wait on the WAL/file lock instead of failing instantly, so we never race the app's own
 * connection pool into a half-applied checkpoint. The app opens this DB with `busy_timeout=5s`
 * (see codex-rs `state::runtime::base_sqlite_options`); we mirror that here.
 */
function openStateDb(stateDbPath: string): Database {
  const db = new Database(stateDbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
  } catch {
    /* best-effort: an older sqlite without busy_timeout still works, just less politely */
  }
  return db;
}

/**
 * Append one JSONL line to a rollout using an O_APPEND handle, exactly like the Codex app's own
 * metadata writer (`append_rollout_item_to_path` in codex-rs `rollout/src/recorder.rs`).
 *
 * Why append instead of rewriting line 1:
 * - The app caches the live session's append handle and only reopens it when the handle is gone
 *   (codex-rs `RolloutWriterState::ensure_writer_open`). A temp+rename swap would orphan that
 *   handle; an in-place truncate would race the app's concurrent appends and clip new turns.
 * - The app folds metadata by replaying every `session_meta` line in file order, last-writer-wins
 *   (codex-rs `apply_session_meta_from_item`), so a trailing `session_meta` overrides earlier ones.
 *   Real rollouts already contain multiple `session_meta` lines for this reason.
 * O_APPEND makes each write land at EOF atomically, so it composes safely with the app appending
 * concurrently. We do not touch mtime: a fresh mtime is correct here (the app uses mtime as the
 * rollout's updated_at), and forcing it backwards could hide a real edit from list ordering.
 */
function appendRolloutLine(path: string, line: string): void {
  const fd = openSync(path, "a");
  try {
    const buf = Buffer.from(line.endsWith("\n") ? line : `${line}\n`, "utf8");
    let offset = 0;
    while (offset < buf.length) {
      offset += writeSync(fd, buf, offset, buf.length - offset, null);
    }
    try { fsyncSync(fd); } catch { /* best-effort durability */ }
  } finally {
    closeSync(fd);
  }
}

/**
 * Patch the `model_provider` value inside the FIRST line of a rollout *in place, length-preserving*.
 *
 * Why this exists in addition to {@link appendRolloutLine}: Codex resolves a thread's provider via
 * two different readers. The SQLite replay path folds every `session_meta` line last-writer-wins
 * (covered by appending a trailing meta), but `read_session_meta_line` reads only the FIRST line
 * and `update_thread_metadata` clones it when the app later writes git/memory-mode metadata
 * (codex-rs `thread-store/src/local/update_thread_metadata.rs`). If the first line still says
 * `opencodex` after a native restore, that clone re-appends `opencodex` and last-writer-wins
 * resurrects the routed provider. So a durable restore must also fix line 1.
 *
 * Safety: Codex parses each rollout line as `serde_json::from_str(line.trim())`, which tolerates
 * insignificant JSON whitespace. We therefore replace the provider value and pad the removed bytes
 * with spaces so the line's byte length is unchanged. Equal length means we can write at offset 0
 * with no truncate and no inode swap, so this composes safely with the app's cached append handle.
 * Only length-preserving shrinks are handled (e.g. "opencodex" -> "openai"); callers that would
 * grow the value fall back to append-only, which is correct for the opencodex direction.
 *
 * Returns true when line 1 was patched, false when it could not be done safely (missing file,
 * non-`session_meta` first line, id mismatch, value already correct, or a length-growing change).
 */
function patchFirstLineProviderInPlace(path: string, expectedId: string, provider: string): boolean {
  if (!existsSync(path)) return false;
  const fd = openSync(path, "r+");
  try {
    // Read the first line by growing the probe until we hit a newline. session_meta lines embed
    // base_instructions and can be tens of KB; a fixed cap would silently skip the in-place patch
    // (and fall back to append-only, re-opening the first-line-clone resurrection gap), so we read
    // until the line actually ends rather than guessing a ceiling.
    const CHUNK = 1 << 16;
    const MAX_FIRST_LINE = 1 << 24; // 16 MiB hard stop so a newline-less/corrupt file can't OOM us.
    let collected = Buffer.alloc(0);
    let nlIndex = -1;
    let pos = 0;
    while (nlIndex === -1) {
      const chunk = Buffer.alloc(CHUNK);
      const read = readSync(fd, chunk, 0, CHUNK, pos);
      if (read === 0) break; // EOF with no newline: single-line file, skip
      collected = Buffer.concat([collected, chunk.subarray(0, read)]);
      nlIndex = collected.indexOf(0x0a);
      pos += read;
      if (collected.length > MAX_FIRST_LINE) return false;
    }
    if (nlIndex === -1) return false; // no newline anywhere: skip
    const firstLine = collected.subarray(0, nlIndex).toString("utf8");

    const meta = parseSessionMetaLine(firstLine);
    if (!meta) return false;
    if (meta.record.payload.id !== expectedId) return false;
    if (meta.record.payload.model_provider === provider) return false;

    // Locate the exact `"model_provider":"<value>"` token (allowing whitespace after the colon).
    const match = firstLine.match(/"model_provider"\s*:\s*"([^"\\]*)"/);
    if (!match || match.index === undefined) return false;
    const oldToken = match[0];
    const newCore = `"model_provider":"${provider}"`;
    if (Buffer.byteLength(newCore, "utf8") > Buffer.byteLength(oldToken, "utf8")) return false; // grow: not length-preserving
    const pad = " ".repeat(Buffer.byteLength(oldToken, "utf8") - Buffer.byteLength(newCore, "utf8"));
    const newToken = `${newCore}${pad}`;

    const patchedLine = firstLine.slice(0, match.index) + newToken + firstLine.slice(match.index + oldToken.length);
    // Length must be identical so the trailing bytes (newline + rest of file) are untouched.
    if (Buffer.byteLength(patchedLine, "utf8") !== Buffer.byteLength(firstLine, "utf8")) return false;
    // Sanity: the patched line must still parse and carry the new provider.
    const reparsed = parseSessionMetaLine(patchedLine);
    if (!reparsed || reparsed.record.payload.model_provider !== provider) return false;

    const out = Buffer.from(patchedLine, "utf8");
    let offset = 0;
    while (offset < out.length) {
      offset += writeSync(fd, out, offset, out.length - offset, offset);
    }
    try { fsyncSync(fd); } catch { /* best-effort durability */ }
    return true;
  } finally {
    closeSync(fd);
  }
}

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
  stateDbPath?: string;
  entries: Record<string, BackupEntry>;
}

interface NativeRestoreTarget {
  modelProvider: string;
  source: string;
  hasUserEvent: number;
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function readBackup(path: string, stateDbPath?: string): BackupManifest {
  if (!existsSync(path)) return { version: 1, stateDbPath, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BackupManifest>;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
      return { version: 1, stateDbPath, entries: {} };
    }
    if (stateDbPath && typeof parsed.stateDbPath === "string" && !samePath(parsed.stateDbPath, stateDbPath)) {
      return { version: 1, stateDbPath, entries: {} };
    }
    return { version: 1, stateDbPath: parsed.stateDbPath ?? stateDbPath, entries: parsed.entries };
  } catch {
    return { version: 1, stateDbPath, entries: {} };
  }
}

function writeBackup(path: string, manifest: BackupManifest, stateDbPath?: string): void {
  if (Object.keys(manifest.entries).length === 0) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFile(path, JSON.stringify({ ...manifest, stateDbPath: manifest.stateDbPath ?? stateDbPath }, null, 2) + "\n");
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

interface ParsedSessionMeta {
  record: { type?: unknown; timestamp?: unknown; payload: { model_provider?: unknown; source?: unknown } & Record<string, unknown> };
}

/** Parse one JSONL line into a `session_meta` record, or null if it isn't one. */
function parseSessionMetaLine(line: string): ParsedSessionMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as ParsedSessionMeta["record"];
  if (record.type !== "session_meta" || !record.payload || typeof record.payload !== "object") return null;
  return { record };
}

/**
 * Find the LAST `session_meta` line in a rollout, mirroring the app's last-writer-wins fold
 * (codex-rs `apply_session_meta_from_item`). We base our patch on the most recent metadata so we
 * never resurrect a stale provider that a later app-written `session_meta` already changed.
 */
function readLatestSessionMeta(path: string): ParsedSessionMeta | null {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    if (!line.includes("\"session_meta\"")) continue;
    const meta = parseSessionMetaLine(line);
    if (meta) return meta;
  }
  return null;
}

/**
 * Make a thread's rollout reflect a provider/source change by APPENDING a new `session_meta` line,
 * rather than rewriting line 1. The appended line clones the latest metadata payload (so no field
 * is accidentally reset to empty) and applies only the requested changes. Returns false when the
 * rollout is missing, has no parseable `session_meta`, its latest `session_meta` belongs to a
 * different thread id, or it already matches the desired values.
 */
function updateSessionMeta(path: string, expectedId: string, patch: { provider?: string; source?: string }): boolean {
  if (!path || !existsSync(path)) return false;

  const latest = readLatestSessionMeta(path);
  if (!latest) return false;
  const record = latest.record;

  // The app ignores `session_meta` lines whose payload id != the canonical thread id
  // (codex-rs `apply_session_meta_from_item`). Forked rollouts can embed a source session's
  // metadata, so an id-mismatched latest line means we'd be cloning the wrong thread's meta and
  // appending a line the app would discard. Skip rather than write a no-op/misleading line.
  const payloadId = record.payload.id;
  if (typeof payloadId !== "string" || payloadId !== expectedId) return false;

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

  // Cover Codex's *other* provider reader: `read_session_meta_line` reads only line 1, and the
  // app clones it when writing later git/memory-mode metadata. Appending alone leaves a stale
  // line-1 provider that the clone would re-append, so for a length-preserving provider change we
  // also patch line 1 in place (no inode swap, no truncate). Best-effort: when it can't be done
  // safely (e.g. a length-growing change), the trailing append below is still correct for the
  // SQLite replay path.
  if (patch.provider !== undefined) {
    try { patchFirstLineProviderInPlace(path, expectedId, patch.provider); } catch { /* best-effort line-1 patch */ }
  }

  // Refresh the line timestamp so the appended record reads as the newest metadata.
  record.timestamp = new Date().toISOString();
  appendRolloutLine(path, JSON.stringify(record));
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
      if (updateSessionMeta(row.rollout_path, row.id, {
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

function isRecoverableHistoryError(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return code === "SQLITE_BUSY"
    || code === "SQLITE_LOCKED"
    || code === "EBUSY"
    || code === "EPERM"
    || code === "EACCES"
    || message.includes("database is locked")
    || message.includes("database is busy")
    || message.includes("resource busy")
    || message.includes("operation not permitted")
    || message.includes("permission denied");
}

export function syncCodexHistoryProvider(provider: CodexHistoryProvider, stateDbPath = STATE_DB_PATH, backupPath = HISTORY_BACKUP_PATH): CodexHistorySyncResult {
  try {
    return syncCodexHistoryProviderUnsafe(provider, stateDbPath, backupPath);
  } catch (error) {
    if (isRecoverableHistoryError(error)) return { rows: 0, files: 0 };
    throw error;
  }
}

function syncCodexHistoryProviderUnsafe(provider: CodexHistoryProvider, stateDbPath: string, backupPath: string): CodexHistorySyncResult {
  if (!existsSync(stateDbPath)) return { rows: 0, files: 0 };
  if (provider === "openai") return restoreCodexHistoryProvider(stateDbPath, backupPath);

  const db = openStateDb(stateDbPath);
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

    const manifest = readBackup(backupPath, stateDbPath);
    for (const row of [...openaiRows, ...execRows]) rememberOriginal(manifest, row);
    writeBackup(backupPath, manifest, stateDbPath);

    let files = 0;
    for (const row of openaiRows) {
      try {
        if (updateSessionMeta(row.rollout_path, row.id, { provider: "opencodex" })) files++;
      } catch {
        /* best-effort; keep DB migration moving even if one old rollout is malformed */
      }
    }
    for (const row of execRows) {
      try {
        if (updateSessionMeta(row.rollout_path, row.id, { source: "cli" })) files++;
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
  const manifest = readBackup(backupPath, stateDbPath);
  const entries = Object.values(manifest.entries);

  const db = openStateDb(stateDbPath);
  try {
    if (entries.length === 0) {
      const ejected = ejectRemainingOpencodexHistory(db);
      return ejected.rows > 0 ? { rows: 0, files: ejected.files, ejectedRows: ejected.rows } : { rows: 0, files: 0 };
    }

    let files = 0;
    for (const entry of entries) {
      const target = toNativeRestoreTarget(entry);
      try {
        if (updateSessionMeta(entry.rolloutPath, entry.id, { provider: target.modelProvider, source: target.source })) files++;
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
    writeBackup(backupPath, { version: 1, stateDbPath, entries: {} }, stateDbPath);
    const ejected = ejectRemainingOpencodexHistory(db);
    return ejected.rows > 0
      ? { rows: entries.length, files: files + ejected.files, ejectedRows: ejected.rows }
      : { rows: entries.length, files };
  } finally {
    db.close();
  }
}

export function restoreLegacyOpenaiHistory(stateDbPath = STATE_DB_PATH): { rows: number; files: number } {
  try {
    if (!existsSync(stateDbPath)) return { rows: 0, files: 0 };
    const db = openStateDb(stateDbPath);
    try {
      return ejectRemainingOpencodexHistory(db);
    } finally {
      db.close();
    }
  } catch (error) {
    if (isRecoverableHistoryError(error)) return { rows: 0, files: 0 };
    throw error;
  }
}
