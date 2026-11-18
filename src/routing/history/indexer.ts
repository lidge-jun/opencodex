/**
 * Derived request-history index (RI-02).
 *
 * `usage.jsonl` stays canonical; this module maintains a rebuildable SQLite
 * projection (ADR-1, ADR-8). On every open/query it verifies schema version,
 * file identity and byte offset, then appends whatever complete
 * JSONL rows arrived since the last index. Missing/corrupt/stale index or a
 * replaced/truncated source triggers an automatic full rebuild; canonical
 * history is never touched.
 *
 * A full rebuild of a ledger of at least `REQUEST_HISTORY_WORKER_REBUILD_MIN_BYTES`
 * runs on a worker thread (#6990): the worker writes a private build file and
 * this thread swaps it in once complete. Async readers wait for it; the
 * routing-time sync entry never waits and throws `RequestHistoryIndexBusyError`.
 * Full integrity scans run on that worker at open and periodically while in
 * use, never synchronously on the serving thread (#7966).
 */

import { Database } from "bun:sqlite";
import { existsSync, renameSync, unlinkSync } from "node:fs";
import { getConfigDir } from "../../config";
import { recordOwnedConfigPath } from "../../lib/config-ownership";
import {
  currentUsageLogRevision,
  encodePersistedRequestedModel,
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
import {
  ingestSourceTail,
  metaValue,
  recordSourceMeta,
  RequestHistoryIndexStaleError,
  resetAndCreateSchema,
  setMeta,
} from "./ingest";
import { buildFilePath, removeBuildFiles } from "./build-file";
import { RebuildWorkerJob } from "./rebuild-job";
import { RequestHistoryIntegrityMonitor, type RequestHistoryIntegrityOptions } from "./integrity";
import { isHistoryIndexCorruption } from "./sqlite-errors";

export {
  REQUEST_HISTORY_INSERT_BATCH,
  REQUEST_HISTORY_MAX_RECORD_BYTES,
  REQUEST_HISTORY_READ_CHUNK_BYTES,
} from "./ingest";

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
// Ledgers at least this large rebuild on the worker; smaller ones rebuild
// inline, where a worker spawn would cost more than the ingest.
export const REQUEST_HISTORY_WORKER_REBUILD_MIN_BYTES = 1024 * 1024;
// A worker build that failed for any reason but a replaced ledger is not
// retried by routing-time reads for this long, so a persistent failure (disk
// full, unreadable ledger) cannot spawn a worker on every routing decision.
const WORKER_FAILURE_COOLDOWN_MS = 30_000;
// Async readers wait for at most this many worker rebuilds before reporting the
// index busy (a ledger replaced again during every build).
const MAX_ASYNC_REFRESH_BUILDS = 4;

/** The index is being rebuilt in the background; routing treats history as unknown meanwhile. */
export class RequestHistoryIndexBusyError extends Error {
  readonly code = "request_history_index_busy";
  constructor(message = "request-history index is rebuilding") {
    super(message);
    this.name = "RequestHistoryIndexBusyError";
  }
}

/** The index was closed while a reader waited for its rebuild. */
export class RequestHistoryIndexClosedError extends Error {
  readonly code = "request_history_index_closed";
  constructor(message = "request-history index was closed during a rebuild") {
    super(message);
    this.name = "RequestHistoryIndexClosedError";
  }
}

interface WorkerRebuild {
  readonly job: RebuildJob;
  readonly promise: Promise<void>;
}

/** The part of a rebuild worker job the indexer drives; tests substitute a failing one. */
type RebuildJob = Pick<RebuildWorkerJob, "build" | "dispose" | "afterExit">;
let createRebuildJob: () => RebuildJob = () => new RebuildWorkerJob();

/** Test seam: replace the worker job factory; `undefined` restores the real worker. */
export function setRequestHistoryRebuildJobFactoryForTests(factory: (() => RebuildJob) | undefined): void {
  createRebuildJob = factory ?? (() => new RebuildWorkerJob());
}

/** Internal signal: the refresh needs a rebuild that is running (or now started) on the worker. */
class RebuildHandedOff {
  constructor(readonly rebuild: WorkerRebuild) {}
}

/** An initial integrity check, or a scanner draining before index replacement. */
class IntegrityHandedOff {
  constructor(readonly promise: Promise<void>) {}
}

let db: Database | null = null;
let dbPath = "";
let openPromise: Promise<RequestHistoryIndexMeta> | null = null;
let manualRebuild: Promise<RequestHistoryIndexMeta> | null = null;
let workerRebuild: WorkerRebuild | null = null;
let workerFailure: { at: number; error: unknown } | null = null;
let workerRebuildMinBytes = REQUEST_HISTORY_WORKER_REBUILD_MIN_BYTES;
let maxAsyncRefreshBuilds = MAX_ASYNC_REFRESH_BUILDS;
let buildSequence = 0;
// Bumped by closeRequestHistoryIndex, so a rebuild finishing after a close is discarded.
let indexLifetime = 0;
let integrity = new RequestHistoryIntegrityMonitor();
let integrityDrain: Promise<void> | null = null;
let corruptHandle: Database | null = null;
let validatedBuildPath: string | null = null;

/** Test seam: replace integrity scheduling without leaving a scanner on an old file. */
export function setRequestHistoryIntegrityOptionsForTests(options?: RequestHistoryIntegrityOptions): void {
  closeRequestHistoryIndex();
  integrity = new RequestHistoryIntegrityMonitor(options);
}

function stopIntegrityScan(): Promise<void> | null {
  const pending = integrity.quiesce();
  if (pending && !integrityDrain) {
    const drained = pending.finally(() => {
      if (integrityDrain === drained) integrityDrain = null;
    });
    integrityDrain = drained;
  }
  return integrityDrain;
}

/** Never delete/rename a database that a cancelled scanner may still hold on Windows. */
function prepareIndexReplacement(): void {
  const pending = stopIntegrityScan();
  if (pending) throw new IntegrityHandedOff(pending);
}

/** Test seam: move the worker threshold; `undefined` restores the default. */
export function setRequestHistoryWorkerRebuildMinBytesForTests(bytes: number | undefined): void {
  workerRebuildMinBytes = bytes ?? REQUEST_HISTORY_WORKER_REBUILD_MIN_BYTES;
}

/** Test seam: how many worker rebuilds one async refresh waits for; `undefined` restores the default. */
export function setRequestHistoryAsyncRefreshBuildsForTests(builds: number | undefined): void {
  maxAsyncRefreshBuilds = builds ?? MAX_ASYNC_REFRESH_BUILDS;
}

function indexDbPath(): string {
  const dir = getConfigDir();
  const path = historyIndexPath(dir);
  recordOwnedConfigPath(dir, path);
  return path;
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

export function sourceIdentityMatches(dbHandle: Database, revision: UsageLogRevision | null): boolean {
  const stored = readIndexedMeta(dbHandle);
  if (revision === null) return stored.sourceSize === 0;
  const storedPath = readStoredMetaField(dbHandle, HISTORY_META_KEYS.sourcePath);
  if (!storedPath) return false;
  // Compared as exact decimal strings; see UsageLogRevision for why ids are not Numbers.
  const storedDev = readStoredMetaField(dbHandle, HISTORY_META_KEYS.sourceDev);
  const storedIno = readStoredMetaField(dbHandle, HISTORY_META_KEYS.sourceIno);
  const storedBirthtimeMs = Number(readStoredMetaField(dbHandle, HISTORY_META_KEYS.sourceBirthtimeMs));
  return storedPath === revision.path
    && storedDev === revision.dev
    && storedIno === revision.ino
    && storedBirthtimeMs === Number(revision.birthtimeMs);
}

/** Remove the index file and its WAL side files. */
function removeIndexFiles(path: string): void {
  // Windows: a partially-opened handle from a failed `new Database` can hold
  // the file briefly after the throw. Retry the unlink before recreating.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      for (const suffix of ["-wal", "-shm"] as const) {
        try { unlinkSync(`${path}${suffix}`); } catch { /* sidecar may not exist */ }
      }
      if (existsSync(path)) unlinkSync(path);
      return;
    } catch {
      if (attempt === 4) return;
      Bun.sleepSync(50);
    }
  }
}

function destroyAndRecreate(path: string, reason: string): Database {
  prepareIndexReplacement();
  if (db) {
    try { db.close(); } catch { /* already closed */ }
    db = null;
  }
  removeIndexFiles(path);
  const fresh = new Database(path, { create: true });
  fresh.exec("PRAGMA journal_mode = WAL");
  fresh.exec("PRAGMA busy_timeout = 5000");
  resetAndCreateSchema(fresh);
  setMeta(fresh, HISTORY_META_KEYS.lastError, reason);
  db = fresh;
  corruptHandle = null;
  validatedBuildPath = null;
  return fresh;
}

function openIndexDb(): Database {
  if (integrityDrain) throw new IntegrityHandedOff(integrityDrain);
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
  } catch (error) {
    // A partially-opened handle on a corrupt file can hold the OS lock on
    // Windows; close it before the destructive recreate.
    if (handle) {
      try { handle.close(); } catch { /* already unusable */ }
    }
    if (!isHistoryIndexCorruption(error)) throw error;
    handle = destroyAndRecreate(path, "unreadable database recreated");
  }
  dbPath = path;
  db = handle;
  if (validatedBuildPath === path) {
    integrity.acceptRebuilt(handle, path);
    validatedBuildPath = null;
  }
  return handle;
}

function ensureSchemaAndIdentity(dbHandle: Database): "ready" | "rebuilt" {
  try {
    if (corruptHandle === dbHandle) {
      destroyAndRecreate(dbPath, "integrity check failed; index rebuilt");
      return "rebuilt";
    }
    const storedVersion = metaValue(dbHandle, HISTORY_META_KEYS.schemaVersion);
    if (storedVersion !== String(HISTORY_SCHEMA_VERSION)) {
      destroyAndRecreate(dbPath, `schema version ${storedVersion ?? "missing"} -> ${HISTORY_SCHEMA_VERSION}`);
      return "rebuilt";
    }
    const revision = sourceIdentity();
    if (!sourceIdentityMatches(dbHandle, revision)) {
      destroyAndRecreate(dbPath, "source identity changed; index rebuilt");
      return "rebuilt";
    }
    const check = integrity.inspect(dbHandle, dbPath);
    if (check.state === "pending") throw new IntegrityHandedOff(check.promise);
    if (check.state === "unavailable") {
      throw new RequestHistoryIndexBusyError("request-history integrity check unavailable");
    }
    if (check.state === "corrupt") {
      corruptHandle = dbHandle;
      destroyAndRecreate(dbPath, "integrity check failed; index rebuilt");
      return "rebuilt";
    }
    return "ready";
  } catch (error) {
    if (!isHistoryIndexCorruption(error)) throw error;
    // A file that opens but is not actually SQLite (or is mid-corruption)
    // throws on the first statement; treat it as corrupt and rebuild.
    corruptHandle = dbHandle;
    integrity.markCorrupt(dbHandle);
    destroyAndRecreate(dbPath, "index unreadable; rebuilt");
    return "rebuilt";
  }
}

function fullRebuild(dbHandle: Database, reason: string): void {
  prepareIndexReplacement();
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
    integrity.acceptRebuilt(dbHandle, dbPath);
    corruptHandle = null;
    return;
  }
  const inserted = ingestSourceTail(dbHandle, path, 0);
  const current = readIndexedMeta(dbHandle);
  setMeta(dbHandle, HISTORY_META_KEYS.indexedRows, inserted);
  setMeta(dbHandle, HISTORY_META_KEYS.indexedOffset, Math.max(current.indexedOffset, 0));
  setMeta(dbHandle, HISTORY_META_KEYS.builtAtMs, Date.now());
  integrity.acceptRebuilt(dbHandle, dbPath);
  corruptHandle = null;
}

/**
 * Start a worker rebuild of `revision`, or return null when no worker can be
 * spawned (the caller then rebuilds inline, as before #6990).
 */
function workerCoolingDown(): boolean {
  return workerFailure !== null && Date.now() - workerFailure.at < WORKER_FAILURE_COOLDOWN_MS;
}

function startWorkerRebuild(reason: string, revision: UsageLogRevision): WorkerRebuild | null {
  let job: RebuildJob;
  try {
    job = createRebuildJob();
  } catch {
    return null;
  }
  const lifetime = indexLifetime;
  const indexPath = dbPath || indexDbPath();
  const buildPath = buildFilePath(indexPath, process.pid, ++buildSequence);
  const rebuild: { job: RebuildJob; promise: Promise<void> } = { job, promise: Promise.resolve() };
  rebuild.promise = job.build(indexPath, buildPath, reason, revision)
    .then(() => {
      if (lifetime !== indexLifetime) throw new RequestHistoryIndexClosedError();
      installBuild(buildPath, indexPath);
      workerFailure = null;
    })
    .catch((error: unknown) => {
      // A replaced ledger is retried at once; a close is nobody's failure.
      if (lifetime === indexLifetime && !(error instanceof RequestHistoryIndexStaleError)) {
        workerFailure = { at: Date.now(), error };
      }
      throw error;
    })
    .finally(() => {
      if (workerRebuild === rebuild) workerRebuild = null;
      void job.afterExit(() => removeBuildFiles(buildPath));
    });
  // A rebuild started by the routing-time entry has no awaiting reader.
  rebuild.promise.catch(() => undefined);
  workerRebuild = rebuild;
  return rebuild;
}

/** Swap a complete worker build in for the current index file. */
function installBuild(buildPath: string, indexPath: string): void {
  prepareIndexReplacement();
  if (db) {
    try { db.close(); } catch { /* already closed */ }
    db = null;
  }
  removeIndexFiles(indexPath);
  renameSync(buildPath, indexPath);
  corruptHandle = null;
  validatedBuildPath = indexPath;
}

/**
 * Who is refreshing. Routing-time reads never rebuild a large ledger inline;
 * async readers do once the worker has just failed, which is the pre-#6990
 * behaviour and better than leaving history unavailable.
 */
type RefreshCaller = "routing" | "reader";

/** Full rebuild, on the worker when the ledger is large enough to stall the event loop. */
function rebuildFromLedger(handle: Database, reason: string, caller: RefreshCaller): void {
  prepareIndexReplacement();
  const revision = sourceIdentity();
  if (revision !== null && Number(revision.size) >= workerRebuildMinBytes) {
    if (workerCoolingDown()) {
      if (caller === "routing") {
        const error = workerFailure!.error;
        const cause = error instanceof Error ? error.message : String(error);
        throw new RequestHistoryIndexBusyError(`request-history index rebuild failed recently: ${cause}`);
      }
    } else {
      const rebuild = startWorkerRebuild(reason, revision);
      if (rebuild) throw new RebuildHandedOff(rebuild);
    }
  }
  fullRebuild(handle, reason);
}

function refreshOnceLockedSync(caller: RefreshCaller): RequestHistoryIndexMeta {
  if (workerRebuild) throw new RebuildHandedOff(workerRebuild);
  openIndexDb();
  const state = ensureSchemaAndIdentity(db!);
  const handle = db!;
  const revision = sourceIdentity();
  if (state === "rebuilt") {
    rebuildFromLedger(handle, "rebuilt after identity/schema mismatch", caller);
    return metaFor(handle);
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
    rebuildFromLedger(handle, "source truncated; index rebuilt", caller);
    return metaFor(handle);
  }
  if (tailNextOffset < Number(revision.size)) {
    const inserted = ingestSourceTail(handle, revision.path, tailNextOffset);
    // A clean tail ingest proves the index is healthy: clear any earlier
    // rebuild marker so status readers can distinguish rebuilds from tails.
    if (inserted > 0) setMeta(handle, HISTORY_META_KEYS.lastError, "");
  }
  return metaFor(handle);
}

function refreshLockedSync(caller: RefreshCaller): RequestHistoryIndexMeta {
  try {
    return refreshOnceLockedSync(caller);
  } catch (error) {
    // Metadata reads and incremental writes can encounter damage even between
    // scheduled checks. Operational failures (busy, locked, I/O, full) propagate.
    if (!isHistoryIndexCorruption(error)) throw error;
    if (db) {
      corruptHandle = db;
      integrity.markCorrupt(db);
    }
    const handle = destroyAndRecreate(dbPath, "SQLite corruption; index rebuilt");
    rebuildFromLedger(handle, "SQLite corruption; index rebuilt", caller);
    return metaFor(handle);
  }
}

/**
 * Synchronous refresh for routing-time evidence reads (RI-06+). Never waits
 * for a worker rebuild: while one runs (this call may start it), throws
 * `RequestHistoryIndexBusyError`, which health scoring reads as unknown evidence.
 */
export function openRequestHistoryIndexSync(): RequestHistoryIndexMeta {
  if (manualRebuild) throw new RequestHistoryIndexBusyError();
  try {
    return refreshLockedSync("routing");
  } catch (error) {
    if (error instanceof RebuildHandedOff || error instanceof IntegrityHandedOff) throw new RequestHistoryIndexBusyError();
    throw error;
  }
}

async function refreshWaitingForWorker(fromManualRebuild = false): Promise<RequestHistoryIndexMeta> {
  const lifetime = indexLifetime;
  for (let builds = 0; ; ) {
    if (manualRebuild && !fromManualRebuild) {
      await manualRebuild;
      if (lifetime !== indexLifetime) throw new RequestHistoryIndexClosedError();
      continue;
    }
    let handedOff: RebuildHandedOff;
    try {
      return refreshLockedSync("reader");
    } catch (error) {
      if (error instanceof IntegrityHandedOff) {
        await error.promise;
        if (lifetime !== indexLifetime) throw new RequestHistoryIndexClosedError();
        continue;
      }
      if (!(error instanceof RebuildHandedOff)) throw error;
      handedOff = error;
    }
    // Only a refresh that needs yet another build hits the limit; one that
    // follows a successful build returns that index above.
    if (builds >= maxAsyncRefreshBuilds) throw new RequestHistoryIndexBusyError();
    let failure: unknown = null;
    await handedOff.rebuild.promise.catch((error: unknown) => { failure = error ?? new Error("rebuild failed"); });
    builds += 1;
    if (lifetime !== indexLifetime) throw new RequestHistoryIndexClosedError();
    if (failure !== null && builds >= maxAsyncRefreshBuilds) throw failure;
  }
}

/**
 * Open (and refresh) the index. Single-flight: concurrent callers share one
 * refresh, and wait for a worker rebuild without blocking the event loop.
 * Missing/corrupt index or ledger state is repaired or reflected in the
 * returned meta; a close during a rebuild rejects with
 * `RequestHistoryIndexClosedError`.
 */
export function openRequestHistoryIndex(): Promise<RequestHistoryIndexMeta> {
  if (!openPromise) {
    const pending = refreshWaitingForWorker().finally(() => {
      if (openPromise === pending) openPromise = null;
    });
    openPromise = pending;
  }
  return openPromise;
}

export function closeRequestHistoryIndex(): void {
  indexLifetime += 1;
  stopIntegrityScan();
  corruptHandle = null;
  validatedBuildPath = null;
  const rebuild = workerRebuild;
  workerRebuild = null;
  workerFailure = null;
  // The rebuild's own settlement removes its build files once the thread exits.
  if (rebuild) void rebuild.job.dispose();
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }
  openPromise = null;
  manualRebuild = null;
}

/** Force a full rebuild from the canonical ledger (CLI / tests). */
export function rebuildRequestHistoryIndex(): Promise<RequestHistoryIndexMeta> {
  if (!manualRebuild) {
    const pending = rebuildManually(indexLifetime).finally(() => {
      if (manualRebuild === pending) manualRebuild = null;
    });
    manualRebuild = pending;
  }
  return manualRebuild;
}

async function rebuildManually(lifetime: number): Promise<RequestHistoryIndexMeta> {
  const draining = stopIntegrityScan();
  if (draining) await draining;
  if (lifetime !== indexLifetime) throw new RequestHistoryIndexClosedError();
  while (workerRebuild) await workerRebuild.promise.catch(() => undefined);
  if (lifetime !== indexLifetime) throw new RequestHistoryIndexClosedError();
  const handle = openIndexDb();
  const revision = sourceIdentity();
  if (revision !== null && Number(revision.size) >= workerRebuildMinBytes) {
    workerFailure = null;
    const rebuild = startWorkerRebuild("manual rebuild requested", revision);
    if (rebuild) {
      try {
        await rebuild.promise;
        if (lifetime !== indexLifetime) throw new RequestHistoryIndexClosedError();
        return refreshWaitingForWorker(true);
      } catch (error) {
        // A close is final; any other worker failure falls back to the inline rebuild below.
        if (lifetime !== indexLifetime || error instanceof RequestHistoryIndexClosedError) throw error;
      }
      fullRebuild(openIndexDb(), "manual rebuild requested");
      return metaFor(db!);
    }
  }
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
  // Rows store the bounded encoded form, so the lookup value must be encoded the
  // same way — short selectors encode to themselves and still match verbatim.
  if (filters.requestedModel !== undefined) add("requested_model = ?", encodePersistedRequestedModel(filters.requestedModel));
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

/** Invalidate only the live generation, including errors from routing's synchronous reads. */
export function reportRequestHistoryCorruption(error: unknown, handle: Database): boolean {
  if (!isHistoryIndexCorruption(error)) return false;
  if (db === handle) {
    corruptHandle = handle;
    integrity.markCorrupt(handle);
  }
  return true;
}

/** Read-only operations may retry once after repair; ordinary SQLite failures propagate. */
export async function withRequestHistoryRead<T>(read: (handle: Database, meta: RequestHistoryIndexMeta) => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const meta = await openRequestHistoryIndex();
    const handle = requireDb();
    try {
      return read(handle, meta);
    } catch (error) {
      if (!reportRequestHistoryCorruption(error, handle) || attempt > 0) throw error;
    }
  }
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
  const cursor = decodeHistoryCursor(rawCursor);
  if (rawCursor !== null && rawCursor !== undefined && cursor === null) {
    throw new InvalidCursorError();
  }
  const limit = Math.min(
    Math.max(1, Math.trunc(pageSize ?? REQUEST_HISTORY_DEFAULT_PAGE_SIZE)),
    REQUEST_HISTORY_MAX_PAGE_SIZE,
  );
  const { rows, fetched, meta } = await withRequestHistoryRead((handle, meta) => ({
    ...queryRows(handle, filters, cursor, limit), meta,
  }));
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
  const row = await withRequestHistoryRead(handle => handle.query("SELECT row_json FROM requests WHERE request_id = ?").get(requestId) as
    | { row_json: string }
    | undefined);
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
