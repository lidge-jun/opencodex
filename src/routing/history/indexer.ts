/**
 * Derived request-history index (RI-02).
 *
 * `usage.jsonl` stays canonical; this module maintains a rebuildable SQLite
 * projection (ADR-1, ADR-8). On every open/query it verifies schema version,
 * file identity, integrity, and byte offset, then appends whatever complete
 * JSONL rows arrived since the last index. Missing/corrupt/stale index or a
 * replaced/truncated source triggers an automatic full rebuild; canonical
 * history is never touched.
 */

import { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  unlinkSync,
} from "node:fs";
import { getConfigDir } from "../../config";
import { recordOwnedConfigPath } from "../../lib/config-ownership";
import {
  currentUsageLogRevision,
  normalizeUsageEntryForTest,
  usageLogPath,
  type PersistedUsageEntry,
  type UsageLogRevision,
} from "../../usage/log";
import {
  HISTORY_DDL,
  HISTORY_META_KEYS,
  HISTORY_SCHEMA_VERSION,
  historyIndexPath,
} from "./schema";
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  InvalidCursorError,
  type HistoryCursor,
} from "./cursor";

export interface RequestHistoryIndexMeta {
  schemaVersion: number;
  dbPath: string;
  sourceSize: number;
  sourceMtimeMs: number;
  indexedOffset: number;
  indexedRows: number;
  builtAtMs: number;
  lastError: string | null;
}

export interface RequestHistoryFilters {
  provider?: string;
  model?: string;
  requestedModel?: string;
  status?: number;
  conversationId?: string;
  surface?: string;
  inboundProtocol?: string;
  apiKeyId?: string;
  profileId?: string;
  fallback?: boolean;
  from?: number;
  to?: number;
}

export interface RequestHistoryPage {
  rows: PersistedUsageEntry[];
  nextCursor?: string;
  hasMore: boolean;
  meta: RequestHistoryIndexMeta;
}

export const REQUEST_HISTORY_MAX_PAGE_SIZE = 100;
export const REQUEST_HISTORY_DEFAULT_PAGE_SIZE = 50;
export const REQUEST_HISTORY_INSERT_BATCH = 500;

let db: Database | null = null;
let dbPath = "";
let openPromise: Promise<RequestHistoryIndexMeta> | null = null;

function indexDbPath(): string {
  const dir = getConfigDir();
  const path = historyIndexPath(dir);
  recordOwnedConfigPath(dir, path);
  return path;
}

function metaValue(dbHandle: Database, key: string): string | null {
  const row = dbHandle.query("SELECT value FROM schema_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setMeta(dbHandle: Database, key: string, value: string | number): void {
  dbHandle.query(
    "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, String(value));
}

function readIndexedMeta(dbHandle: Database): Omit<RequestHistoryIndexMeta, "dbPath"> {
  const asNumber = (key: string): number => {
    const value = metaValue(dbHandle, key);
    const parsed = value === null ? NaN : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    schemaVersion: asNumber(HISTORY_META_KEYS.schemaVersion) || HISTORY_SCHEMA_VERSION,
    sourceSize: asNumber(HISTORY_META_KEYS.sourceSize),
    sourceMtimeMs: asNumber(HISTORY_META_KEYS.sourceMtimeMs),
    indexedOffset: asNumber(HISTORY_META_KEYS.indexedOffset),
    indexedRows: asNumber(HISTORY_META_KEYS.indexedRows),
    builtAtMs: asNumber(HISTORY_META_KEYS.builtAtMs),
    lastError: metaValue(dbHandle, HISTORY_META_KEYS.lastError),
  };
}

function metaFor(dbHandle: Database): RequestHistoryIndexMeta {
  return { dbPath, ...readIndexedMeta(dbHandle) };
}

function sourceIdentity(): UsageLogRevision | null {
  return currentUsageLogRevision();
}

function readStoredMetaField(dbHandle: Database, key: string): string {
  return metaValue(dbHandle, key) ?? "";
}

function sourceIdentityMatches(dbHandle: Database, revision: UsageLogRevision | null): boolean {
  const stored = readIndexedMeta(dbHandle);
  if (revision === null) return stored.sourceSize === 0;
  const storedPath = readStoredMetaField(dbHandle, HISTORY_META_KEYS.sourcePath);
  if (!storedPath) return false;
  const storedDev = Number(readStoredMetaField(dbHandle, HISTORY_META_KEYS.sourceDev));
  const storedIno = Number(readStoredMetaField(dbHandle, HISTORY_META_KEYS.sourceIno));
  const storedBirthtimeMs = Number(readStoredMetaField(dbHandle, HISTORY_META_KEYS.sourceBirthtimeMs));
  return storedPath === revision.path
    && storedDev === Number(revision.dev)
    && storedIno === Number(revision.ino)
    && storedBirthtimeMs === Number(revision.birthtimeMs);
}

/** Extract the `requests` row columns from a canonical persisted entry. */
function extractRow(entry: PersistedUsageEntry): Array<string | number | null> {
  const attempts = entry.attempts;
  return [
    entry.requestId,
    entry.timestamp,
    entry.provider,
    entry.model,
    entry.requestedModel ?? null,
    entry.status,
    entry.surface ?? null,
    entry.inboundProtocol ?? null,
    entry.apiKeyId ?? null,
    entry.conversationId ?? null,
    entry.routeDecision?.routeKind ?? null,
    entry.routeDecision?.profile?.id ?? null,
    entry.routeDecision?.profile?.revision ?? null,
    (attempts?.length ?? 0) > 1 ? 1 : 0,
    entry.durationMs,
    entry.firstOutputMs ?? null,
    entry.usageStatus,
    entry.usage ? JSON.stringify(entry.usage) : null,
    entry.totalTokens ?? null,
    entry.errorCode ?? null,
    entry.terminalStatus ?? null,
    entry.closeReason ?? null,
    attempts?.length ?? 1,
    entry.routeDecision ? JSON.stringify(entry.routeDecision) : null,
    JSON.stringify(entry),
  ];
}

const ROW_INSERT = `
INSERT OR IGNORE INTO requests (
  request_id, timestamp, provider, model, requested_model, status, surface,
  inbound_protocol, api_key_id, conversation_id, route_kind, profile_id,
  profile_revision, fallback, duration_ms, first_output_ms, usage_status,
  usage_json, total_tokens, error_code, terminal_status, close_reason,
  attempt_count, decision_json, row_json
) VALUES (
  ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?
)`;

function readCompleteTail(fd: number, fromOffset: number, size: number): { text: string; nextOffset: number } {
  if (size <= fromOffset) return { text: "", nextOffset: fromOffset };
  const length = size - fromOffset;
  const buf = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const read = readSync(fd, buf, offset, length - offset, fromOffset + offset);
    if (read === 0) throw new Error("usage log changed while indexing");
    offset += read;
  }
  const newline = buf.lastIndexOf(0x0a);
  if (newline < 0) return { text: "", nextOffset: fromOffset };
  return {
    text: buf.subarray(0, newline).toString("utf-8"),
    nextOffset: fromOffset + newline + 1,
  };
}

function parsedEntryFromLine(line: string): PersistedUsageEntry | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as PersistedUsageEntry;
    if (parsed && typeof parsed === "object"
      && typeof parsed.requestId === "string"
      && typeof parsed.timestamp === "number"
      && typeof parsed.provider === "string") {
      return parsed;
    }
  } catch {
    /* skip partial / hand-edited lines, same as every other reader */
  }
  return null;
}

function ingestText(dbHandle: Database, text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r?\n/);
  let inserted = 0;
  let pending: Array<Array<string | number | null>> = [];
  const insert = dbHandle.prepare(ROW_INSERT);
  try {
    const commitBatch = () => {
      dbHandle.transaction((rows: Array<Array<string | number | null>>) => {
        for (const row of rows) {
          // `changes` counts real inserts only; INSERT OR IGNORE replays add 0.
          inserted += insert.run(...row).changes;
        }
      })(pending);
      pending = [];
    };
    for (const line of lines) {
      const entry = parsedEntryFromLine(line);
      if (!entry) continue;
      pending.push(extractRow(entry));
      if (pending.length >= REQUEST_HISTORY_INSERT_BATCH) commitBatch();
    }
    if (pending.length > 0) commitBatch();
  } finally {
    // Windows file locks: an unterminated prepared statement keeps the DB
    // file busy after close (verified on Bun 1.3.14). Finalize always.
    insert.finalize();
  }
  return inserted;
}

function ingestSourceTail(dbHandle: Database, path: string, fromOffset: number): number {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    const { text, nextOffset } = readCompleteTail(fd, fromOffset, Number(stat.size));
    if (text.length === 0 && nextOffset === fromOffset) return 0;
    const inserted = ingestText(dbHandle, text);
    const current = readIndexedMeta(dbHandle);
    setMeta(dbHandle, HISTORY_META_KEYS.indexedOffset, nextOffset);
    setMeta(dbHandle, HISTORY_META_KEYS.indexedRows, current.indexedRows + inserted);
    setMeta(dbHandle, HISTORY_META_KEYS.sourceSize, Number(stat.size));
    setMeta(dbHandle, HISTORY_META_KEYS.sourceMtimeMs, Number(stat.mtimeMs));
    setMeta(dbHandle, HISTORY_META_KEYS.builtAtMs, Date.now());
    return inserted;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function resetAndCreateSchema(dbHandle: Database): void {
  dbHandle.exec("DROP TABLE IF EXISTS requests");
  dbHandle.exec("DROP TABLE IF EXISTS schema_meta");
  dbHandle.exec(HISTORY_DDL);
  setMeta(dbHandle, HISTORY_META_KEYS.schemaVersion, HISTORY_SCHEMA_VERSION);
  setMeta(dbHandle, HISTORY_META_KEYS.indexedOffset, 0);
  setMeta(dbHandle, HISTORY_META_KEYS.indexedRows, 0);
  setMeta(dbHandle, HISTORY_META_KEYS.builtAtMs, Date.now());
  setMeta(dbHandle, HISTORY_META_KEYS.lastError, "rebuilt");
}

function recordSourceMeta(dbHandle: Database, revision: UsageLogRevision | null): void {
  setMeta(dbHandle, HISTORY_META_KEYS.sourcePath, revision?.path ?? "");
  setMeta(dbHandle, HISTORY_META_KEYS.sourceDev, revision?.dev ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceIno, revision?.ino ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceBirthtimeMs, revision?.birthtimeMs ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceSize, revision?.size ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceMtimeMs, revision?.mtimeMs ?? 0);
}

function isHealthy(dbHandle: Database): boolean {
  try {
    const row = dbHandle.query("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    return row?.quick_check === "ok";
  } catch {
    return false;
  }
}

function destroyAndRecreate(path: string, reason: string): Database {
  if (db) {
    try { db.close(); } catch { /* already closed */ }
    db = null;
  }
  // Windows: a partially-opened handle from a failed `new Database` can hold
  // the file briefly after the throw. Retry the unlink before recreating.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      for (const suffix of ["-wal", "-shm"] as const) {
        try { unlinkSync(`${path}${suffix}`); } catch { /* sidecar may not exist */ }
      }
      unlinkSync(path);
      break;
    } catch {
      if (attempt === 4) break;
      Bun.sleepSync(50);
    }
  }
  const fresh = new Database(path, { create: true });
  fresh.exec("PRAGMA journal_mode = WAL");
  fresh.exec("PRAGMA busy_timeout = 5000");
  resetAndCreateSchema(fresh);
  setMeta(fresh, HISTORY_META_KEYS.lastError, reason);
  db = fresh;
  return fresh;
}

function openIndexDb(): Database {
  const path = indexDbPath();
  if (db) return db;
  let handle: Database | undefined;
  try {
    handle = new Database(path, { create: true });
    handle.exec("PRAGMA journal_mode = WAL");
    handle.exec("PRAGMA busy_timeout = 5000");
    handle.exec(HISTORY_DDL);
    if (metaValue(handle, HISTORY_META_KEYS.schemaVersion) === null) {
      // Fresh database: record the schema version so the next refresh treats
      // it as current instead of destroying the file we just created.
      setMeta(handle, HISTORY_META_KEYS.schemaVersion, HISTORY_SCHEMA_VERSION);
      setMeta(handle, HISTORY_META_KEYS.indexedOffset, 0);
      setMeta(handle, HISTORY_META_KEYS.indexedRows, 0);
      setMeta(handle, HISTORY_META_KEYS.builtAtMs, Date.now());
      setMeta(handle, HISTORY_META_KEYS.lastError, "created");
    }
  } catch {
    // A partially-opened handle on a corrupt file can hold the OS lock on
    // Windows; close it before the destructive recreate.
    if (handle) {
      try { handle.close(); } catch { /* already unusable */ }
    }
    handle = destroyAndRecreate(path, "unreadable database recreated");
  }
  dbPath = path;
  db = handle;
  return handle;
}

function ensureSchemaAndIdentity(dbHandle: Database): "ready" | "rebuilt" {
  try {
    const storedVersion = metaValue(dbHandle, HISTORY_META_KEYS.schemaVersion);
    if (storedVersion !== String(HISTORY_SCHEMA_VERSION)) {
      destroyAndRecreate(dbPath, `schema version ${storedVersion ?? "missing"} -> ${HISTORY_SCHEMA_VERSION}`);
      return "rebuilt";
    }
    if (!isHealthy(dbHandle)) {
      destroyAndRecreate(dbPath, "integrity check failed; index rebuilt");
      return "rebuilt";
    }
    const revision = sourceIdentity();
    if (!sourceIdentityMatches(dbHandle, revision)) {
      destroyAndRecreate(dbPath, "source identity changed; index rebuilt");
      return "rebuilt";
    }
    return "ready";
  } catch {
    // A file that opens but is not actually SQLite (or is mid-corruption)
    // throws on the first statement; treat it as corrupt and rebuild.
    destroyAndRecreate(dbPath, "index unreadable; rebuilt");
    return "rebuilt";
  }
}

function fullRebuild(dbHandle: Database, reason: string): void {
  resetAndCreateSchema(dbHandle);
  setMeta(dbHandle, HISTORY_META_KEYS.lastError, reason);
  const path = usageLogPath();
  const revision = sourceIdentity();
  recordSourceMeta(dbHandle, revision);
  if (!existsSync(path)) {
    setMeta(dbHandle, HISTORY_META_KEYS.sourceSize, 0);
    setMeta(dbHandle, HISTORY_META_KEYS.indexedOffset, 0);
    setMeta(dbHandle, HISTORY_META_KEYS.indexedRows, 0);
    setMeta(dbHandle, HISTORY_META_KEYS.builtAtMs, Date.now());
    return;
  }
  const inserted = ingestSourceTail(dbHandle, path, 0);
  const current = readIndexedMeta(dbHandle);
  setMeta(dbHandle, HISTORY_META_KEYS.indexedRows, inserted);
  setMeta(dbHandle, HISTORY_META_KEYS.indexedOffset, Math.max(current.indexedOffset, 0));
  setMeta(dbHandle, HISTORY_META_KEYS.builtAtMs, Date.now());
}

async function refreshLocked(): Promise<RequestHistoryIndexMeta> {
  openIndexDb();
  const state = ensureSchemaAndIdentity(db!);
  const handle = db!;
  const revision = sourceIdentity();
  if (state === "rebuilt") {
    fullRebuild(db!, "rebuilt after identity/schema mismatch");
    return metaFor(db!);
  }
  const current = readIndexedMeta(handle);
  if (revision === null) {
    // Source gone: the derived index must not outlive its canonical ledger.
    if (current.indexedRows > 0) fullRebuild(handle, "source ledger missing; index reset");
    return metaFor(handle);
  }
  const tailNextOffset = current.indexedOffset;
  if (Number(revision.size) < tailNextOffset) {
    // Truncated source: offsets no longer make sense.
    fullRebuild(handle, "source truncated; index rebuilt");
    return metaFor(handle);
  }
  if (tailNextOffset < Number(revision.size)) {
    ingestSourceTail(handle, revision.path, tailNextOffset);
  }
  return metaFor(handle);
}

/**
 * Open (and refresh) the index. Single-flight: concurrent callers share one
 * refresh. Never throws for missing/corrupt index or ledger state; those are
 * repaired or reflected in the returned meta.
 */
export function openRequestHistoryIndex(): Promise<RequestHistoryIndexMeta> {
  if (!openPromise) {
    openPromise = refreshLocked().finally(() => {
      openPromise = null;
    });
  }
  return openPromise;
}

export function closeRequestHistoryIndex(): void {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }
  openPromise = null;
}

/** Force a full rebuild from the canonical ledger (CLI / tests). */
export async function rebuildRequestHistoryIndex(): Promise<RequestHistoryIndexMeta> {
  const handle = openIndexDb();
  fullRebuild(handle, "manual rebuild requested");
  return metaFor(handle);
}

type HistoryQueryRow = {
  row_json: string;
  timestamp?: number;
  request_id?: string;
};

function queryRows(
  handle: Database,
  filters: RequestHistoryFilters,
  cursor: HistoryCursor | null,
  limit: number,
): { rows: Array<HistoryQueryRow>; fetched: number } {
  const where: string[] = [];
  const values: Array<string | number> = [];
  const add = (clause: string, value: string | number) => {
    where.push(clause);
    values.push(value);
  };
  if (filters.provider !== undefined) add("provider = ?", filters.provider);
  if (filters.model !== undefined) add("model = ?", filters.model);
  if (filters.requestedModel !== undefined) add("requested_model = ?", filters.requestedModel);
  if (filters.status !== undefined) add("status = ?", filters.status);
  if (filters.conversationId !== undefined) add("conversation_id = ?", filters.conversationId);
  if (filters.surface !== undefined) add("surface = ?", filters.surface);
  if (filters.inboundProtocol !== undefined) add("inbound_protocol = ?", filters.inboundProtocol);
  if (filters.apiKeyId !== undefined) add("api_key_id = ?", filters.apiKeyId);
  if (filters.profileId !== undefined) add("profile_id = ?", filters.profileId);
  if (filters.fallback !== undefined) add("fallback = ?", filters.fallback ? 1 : 0);
  if (filters.from !== undefined) add("timestamp >= ?", filters.from);
  if (filters.to !== undefined) add("timestamp <= ?", filters.to);
  if (cursor) {
    where.push("(timestamp < ? OR (timestamp = ? AND request_id < ?))");
    values.push(cursor.t, cursor.t, cursor.i);
  }
  const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  const rows = handle.query(
    `SELECT row_json, timestamp, request_id FROM requests${whereSql} ORDER BY timestamp DESC, request_id DESC LIMIT ?`,
  ).all(...values, limit + 1) as Array<HistoryQueryRow>;
  return { rows, fetched: rows.length };
}

function requireDb(): Database {
  const handle = db;
  if (!handle) throw new Error("request-history index is not open");
  return handle;
}

function hydrateRow(row: HistoryQueryRow | undefined): PersistedUsageEntry | null {
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.row_json) as PersistedUsageEntry;
    if (parsed && typeof parsed === "object" && typeof parsed.requestId === "string") {
      return normalizeUsageEntryForTest(parsed);
    }
  } catch {
    /* defensive: a damaged row is skipped, canonical ledger unaffected */
  }
  return null;
}

export async function queryRequestHistory(
  filters: RequestHistoryFilters,
  rawCursor: string | null | undefined,
  pageSize: number | undefined,
): Promise<RequestHistoryPage> {
  const meta = await openRequestHistoryIndex();
  const cursor = decodeHistoryCursor(rawCursor);
  if (rawCursor !== null && rawCursor !== undefined && cursor === null) {
    throw new InvalidCursorError();
  }
  const limit = Math.min(
    Math.max(1, Math.trunc(pageSize ?? REQUEST_HISTORY_DEFAULT_PAGE_SIZE)),
    REQUEST_HISTORY_MAX_PAGE_SIZE,
  );
  const handle = requireDb();
  const { rows, fetched } = queryRows(handle, filters, cursor, limit);
  const hasMore = fetched > limit;
  const pageRows = rows.slice(0, limit);
  const entries: PersistedUsageEntry[] = [];
  for (const row of pageRows) {
    const entry = hydrateRow(row);
    if (entry) entries.push(entry);
  }
  let nextCursor: string | undefined;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1]!;
    nextCursor = encodeHistoryCursor({ t: last.timestamp!, i: last.request_id! });
  }
  return { rows: entries, ...(nextCursor ? { nextCursor } : {}), hasMore, meta };
}

export async function requestHistoryRowById(requestId: string): Promise<PersistedUsageEntry | null> {
  await openRequestHistoryIndex();
  const handle = requireDb();
  const row = handle.query("SELECT row_json FROM requests WHERE request_id = ?").get(requestId) as
    | { row_json: string }
    | undefined;
  return hydrateRow(row);
}

export async function requestHistoryIndexStatus(): Promise<RequestHistoryIndexMeta> {
  return openRequestHistoryIndex();
}

/**
 * Raw handle for analytics-style queries. Callers must await
 * `openRequestHistoryIndex()` first; the handle is valid until
 * `closeRequestHistoryIndex()`.
 */
export function requestHistoryDb(): Database {
  if (!db) throw new Error("request-history index is not open");
  return db;
}
