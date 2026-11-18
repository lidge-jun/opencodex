/**
 * Ingest of canonical `usage.jsonl` rows into a request-history index file.
 *
 * Shared by the serving thread (tails, small rebuilds) and the rebuild worker
 * (large rebuilds, #6990), so both produce identical rows and meta. This
 * module imports no config or indexer state; the worker loads it on its own.
 */

import type { Database } from "bun:sqlite";
import { closeSync, fstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import {
  encodePersistedRequestedModel,
  exactFileIdentity,
  type PersistedUsageEntry,
  type UsageLogRevision,
} from "../../usage/log";
import { HISTORY_DDL, HISTORY_META_KEYS, HISTORY_SCHEMA_VERSION } from "./schema";

export const REQUEST_HISTORY_INSERT_BATCH = 500;
export const REQUEST_HISTORY_READ_CHUNK_BYTES = 64 * 1024;
// The SQLite index is a disposable projection. Complete JSONL records above
// this bound are omitted from the projection; the canonical usage.jsonl is
// never truncated or rewritten by the indexer.
export const REQUEST_HISTORY_MAX_RECORD_BYTES = 1024 * 1024;

// One small observation per live database handle, never retained ledger bytes. An
// unterminated tail cannot advance indexedOffset, but need not be reread until its
// exact file revision changes. Schema/identity gates and lifecycle integrity checks still apply.
const tailObservations = new WeakMap<Database, {
  path: string;
  revision: string;
  nextOffset: number;
  endOffset: number | undefined;
}>();

function tailRevision(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.birthtimeNs, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

/** The ledger at the recorded path is no longer the file the rebuild started from. */
export class RequestHistoryIndexStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestHistoryIndexStaleError";
  }
}

export function metaValue(dbHandle: Database, key: string): string | null {
  const row = dbHandle.query("SELECT value FROM schema_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(dbHandle: Database, key: string, value: string | number): void {
  dbHandle.query(
    "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, String(value));
}

function metaNumber(dbHandle: Database, key: string): number {
  const value = metaValue(dbHandle, key);
  const parsed = value === null ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function resetAndCreateSchema(dbHandle: Database): void {
  tailObservations.delete(dbHandle);
  dbHandle.exec("DROP TABLE IF EXISTS requests");
  dbHandle.exec("DROP TABLE IF EXISTS schema_meta");
  dbHandle.exec(HISTORY_DDL);
  setMeta(dbHandle, HISTORY_META_KEYS.schemaVersion, HISTORY_SCHEMA_VERSION);
  setMeta(dbHandle, HISTORY_META_KEYS.indexedOffset, 0);
  setMeta(dbHandle, HISTORY_META_KEYS.indexedRows, 0);
  setMeta(dbHandle, HISTORY_META_KEYS.builtAtMs, Date.now());
  setMeta(dbHandle, HISTORY_META_KEYS.lastError, "rebuilt");
}

export function recordSourceMeta(dbHandle: Database, revision: UsageLogRevision | null): void {
  tailObservations.delete(dbHandle);
  setMeta(dbHandle, HISTORY_META_KEYS.sourcePath, revision?.path ?? "");
  setMeta(dbHandle, HISTORY_META_KEYS.sourceDev, revision?.dev ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceIno, revision?.ino ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceBirthtimeMs, revision?.birthtimeMs ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceSize, revision?.size ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceMtimeMs, revision?.mtimeMs ?? 0);
}

/** Extract the `requests` row columns from a canonical persisted entry. */
function extractRow(entry: PersistedUsageEntry): Array<string | number | null> {
  const attempts = entry.attempts;
  return [
    entry.requestId,
    entry.timestamp,
    entry.provider,
    entry.model,
    // Old canonical JSONL rows can predate bounded selector persistence. Encode
    // the disposable projection on rebuild so exact filters match across versions.
    typeof entry.requestedModel === "string" ? encodePersistedRequestedModel(entry.requestedModel) : null,
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

function parsedEntryFromLine(line: string): PersistedUsageEntry | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as PersistedUsageEntry;
    if (parsed && typeof parsed === "object"
      && typeof parsed.requestId === "string"
      && typeof parsed.timestamp === "number"
      && typeof parsed.provider === "string"
      && typeof parsed.model === "string"
      && typeof parsed.status === "number"
      && typeof parsed.durationMs === "number") {
      return parsed;
    }
  } catch {
    /* skip partial / hand-edited lines, same as every other reader */
  }
  return null;
}

export interface IngestOptions {
  /** Ledger file the caller recorded; a different file at the path makes the ingest stale. */
  expected?: Pick<UsageLogRevision, "dev" | "ino">;
  /**
   * Stop at this byte offset instead of the size observed when the ingest
   * opens the ledger, so a worker rebuild indexes the snapshot its refresh
   * recorded and the next refresh picks up later appends as a tail.
   */
  endOffset?: number;
}

export function ingestSourceTail(
  dbHandle: Database,
  path: string,
  fromOffset: number,
  options: IngestOptions = {},
): number {
  let inserted = 0;
  let pending: Array<Array<string | number | null>> = [];
  const insert = dbHandle.prepare(ROW_INSERT);
  let fd: number | undefined;
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
    const ingestLine = (line: Buffer) => {
      const entry = parsedEntryFromLine(line.toString("utf-8"));
      if (!entry) return;
      pending.push(extractRow(entry));
      if (pending.length >= REQUEST_HISTORY_INSERT_BATCH) commitBatch();
    };

    fd = openSync(path, "r");
    const stat = fstatSync(fd, { bigint: true });
    const expected = options.expected;
    if (expected) {
      const opened = exactFileIdentity(fd);
      if (opened.dev !== expected.dev || opened.ino !== expected.ino) {
        throw new RequestHistoryIndexStaleError("usage log changed before indexing");
      }
    }
    const revision = tailRevision(stat);
    const observed = tailObservations.get(dbHandle);
    if (observed?.path === path && observed.revision === revision
      && observed.nextOffset === fromOffset && observed.endOffset === options.endOffset) return 0;
    // A failed or interrupted attempt must never publish a reusable observation.
    tailObservations.delete(dbHandle);
    const size = options.endOffset === undefined
      ? Number(stat.size)
      : Math.min(Number(stat.size), options.endOffset);
    const readBuffer = Buffer.allocUnsafe(REQUEST_HISTORY_READ_CHUNK_BYTES);
    let position = fromOffset;
    let nextOffset = fromOffset;
    let fragments: Buffer[] = [];
    let fragmentBytes = 0;
    let oversized = false;
    while (position < size) {
      const requested = Math.min(readBuffer.length, size - position);
      const bytesRead = readSync(fd, readBuffer, 0, requested, position);
      if (bytesRead === 0) throw new RequestHistoryIndexStaleError("usage log changed while indexing");
      let lineStart = 0;
      for (let index = 0; index < bytesRead; index++) {
        if (readBuffer[index] !== 0x0a) continue;
        const segment = readBuffer.subarray(lineStart, index);
        if (!oversized && fragmentBytes + segment.length <= REQUEST_HISTORY_MAX_RECORD_BYTES) {
          const line = fragments.length === 0
            ? segment
            : Buffer.concat([...fragments, segment], fragmentBytes + segment.length);
          ingestLine(line);
        }
        fragments = [];
        fragmentBytes = 0;
        oversized = false;
        lineStart = index + 1;
        nextOffset = position + index + 1;
      }
      const remainder = readBuffer.subarray(lineStart, bytesRead);
      if (!oversized && fragmentBytes + remainder.length <= REQUEST_HISTORY_MAX_RECORD_BYTES) {
        // Copy because readBuffer is reused on the next iteration.
        fragments.push(Buffer.from(remainder));
        fragmentBytes += remainder.length;
      } else if (remainder.length > 0) {
        fragments = [];
        fragmentBytes = 0;
        oversized = true;
      }
      position += bytesRead;
    }
    if (pending.length > 0) commitBatch();
    const indexedRows = metaNumber(dbHandle, HISTORY_META_KEYS.indexedRows);
    setMeta(dbHandle, HISTORY_META_KEYS.indexedOffset, nextOffset);
    setMeta(dbHandle, HISTORY_META_KEYS.indexedRows, indexedRows + inserted);
    setMeta(dbHandle, HISTORY_META_KEYS.sourceSize, size);
    setMeta(dbHandle, HISTORY_META_KEYS.sourceMtimeMs, Number(stat.mtimeNs) / 1_000_000);
    setMeta(dbHandle, HISTORY_META_KEYS.builtAtMs, Date.now());
    if (nextOffset < size && tailRevision(fstatSync(fd, { bigint: true })) === revision) {
      tailObservations.set(dbHandle, { path, revision, nextOffset, endOffset: options.endOffset });
    }
    return inserted;
  } finally {
    if (fd !== undefined) closeSync(fd);
    // Windows file locks: an unterminated prepared statement keeps the DB
    // file busy after close (verified on Bun 1.3.14). Finalize always.
    insert.finalize();
  }
}
