import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { Database } from "bun:sqlite";
import { resolveCodexStateDbPath } from "./paths";
import { atomicWriteFile, getConfigDir } from "../config";
import {
  CODEX_HISTORY_RESUMABLE_SOURCES,
  codexHistoryBackupId,
  sameCodexHistoryPath,
  validateCodexHistoryBackupManifest,
  type CodexHistoryBackupEntry,
  type CodexHistoryBackupManifest,
} from "./history-manifest";

/**
 * Cap for decompressing a lone `.jsonl.zst` rollout during quarantine restore.
 * Bounds peak memory while reconstructing thread rows; never write the decoded
 * JSONL to disk.
 */
export const MAX_ROLLOUT_ZST_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

/**
 * The manifest that shadows one state database.
 *
 * Exported because the history job must resolve it at CALL time for a Worker
 * that does not inherit this module's load-time constants — and must resolve it
 * the same way, since a manifest addressed differently is a different manifest.
 */
export function historyBackupPathFor(stateDbPath: string): string {
  return join(getConfigDir(), `codex-history-backup-${codexHistoryBackupId(stateDbPath)}.json`);
}

/**
 * Open the live `state_5.sqlite` the way the Codex app expects a *secondary* writer to behave:
 * wait on the WAL/file lock instead of failing instantly, so we never race the app's own
 * connection pool into a half-applied checkpoint. The app opens this DB with `busy_timeout=5s`
 * (see codex-rs `state::runtime::base_sqlite_options`); we mirror that here.
 */
let historyDbBusyTimeoutMs = 5000;

/**
 * Test-only knob: Windows CI can spend the FULL busy timeout on a transient file lock, which
 * alone exceeds bun's 5s default per-test timeout. Tests shrink this so a busy DB fails fast
 * into withHistoryRetry instead of stalling; production keeps the codex-rs-matching 5s.
 */
export function setHistoryDbBusyTimeoutForTests(ms: number): void {
  historyDbBusyTimeoutMs = ms;
}

function openStateDb(stateDbPath: string): Database {
  const db = new Database(stateDbPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${historyDbBusyTimeoutMs}`);
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
function appendRolloutLine(path: string, line: string): Buffer {
  const fd = openSync(path, "a");
  const buf = Buffer.from(line.endsWith("\n") ? line : `${line}\n`, "utf8");
  try {
    let offset = 0;
    while (offset < buf.length) {
      offset += writeSync(fd, buf, offset, buf.length - offset, null);
    }
    try { fsyncSync(fd); } catch { /* best-effort durability */ }
  } finally {
    closeSync(fd);
  }
  return buf;
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
 * A previous shrink leaves JSON whitespace in the token slot. That padding is part of the slot,
 * so an exact restore can later grow "openai" back to "opencodex" without moving any bytes.
 *
 * Distinguishes an already-correct line from an unsafe one so exact restore never consumes its
 * manifest after only the trailing metadata was repaired.
 */
type FirstLineProviderResult = "current" | "patched" | "unsafe";

type FirstLineProviderPlan =
  | { readonly state: "current" }
  | { readonly state: "patchable"; readonly patchedLine: string }
  | { readonly state: "unsafe" };

function readFirstRolloutLine(fd: number): string | null {
  // session_meta lines embed base_instructions and can be tens of KB; grow until the line
  // actually ends rather than imposing a small fixed probe that would reject valid history.
  const CHUNK = 1 << 16;
  const MAX_FIRST_LINE = 1 << 24;
  let collected = Buffer.alloc(0);
  let nlIndex = -1;
  let pos = 0;
  while (nlIndex === -1) {
    const chunk = Buffer.alloc(CHUNK);
    const read = readSync(fd, chunk, 0, CHUNK, pos);
    if (read === 0) break;
    collected = Buffer.concat([collected, chunk.subarray(0, read)]);
    nlIndex = collected.indexOf(0x0a);
    pos += read;
    if (collected.length > MAX_FIRST_LINE) return null;
  }
  return nlIndex === -1 ? null : collected.subarray(0, nlIndex).toString("utf8");
}

function planFirstLineProvider(firstLine: string, expectedId: string, provider: string): FirstLineProviderPlan {
  const meta = parseSessionMetaLine(firstLine);
  if (!meta || meta.record.payload.id !== expectedId) return { state: "unsafe" };
  if (meta.record.payload.model_provider === provider) return { state: "current" };

  // Include JSON whitespace after the value. A prior length-preserving shrink stores its spare
  // bytes there, so the exact reverse restore may grow back into that padding.
  const match = firstLine.match(/"model_provider"\s*:\s*"([^"\\]*)"[ \t]*/);
  if (!match || match.index === undefined) return { state: "unsafe" };
  const oldToken = match[0];
  const newCore = `"model_provider":"${provider}"`;
  if (Buffer.byteLength(newCore, "utf8") > Buffer.byteLength(oldToken, "utf8")) return { state: "unsafe" };
  const pad = " ".repeat(Buffer.byteLength(oldToken, "utf8") - Buffer.byteLength(newCore, "utf8"));
  const patchedLine = firstLine.slice(0, match.index) + newCore + pad + firstLine.slice(match.index + oldToken.length);
  if (Buffer.byteLength(patchedLine, "utf8") !== Buffer.byteLength(firstLine, "utf8")) return { state: "unsafe" };
  const reparsed = parseSessionMetaLine(patchedLine);
  if (!reparsed
    || reparsed.record.payload.id !== expectedId
    || reparsed.record.payload.model_provider !== provider) return { state: "unsafe" };
  return { state: "patchable", patchedLine };
}

function inspectFirstLineProvider(path: string, expectedId: string, provider: string): "current" | "patchable" | "unsafe" {
  if (!existsSync(path)) return "unsafe";
  const fd = openSync(path, "r");
  try {
    const firstLine = readFirstRolloutLine(fd);
    return firstLine === null ? "unsafe" : planFirstLineProvider(firstLine, expectedId, provider).state;
  } finally {
    closeSync(fd);
  }
}

function readFirstLineProviderValue(path: string, expectedId: string): string | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, "r");
  try {
    const firstLine = readFirstRolloutLine(fd);
    if (firstLine === null) return null;
    const meta = parseSessionMetaLine(firstLine);
    if (!meta || meta.record.payload.id !== expectedId) return null;
    return typeof meta.record.payload.model_provider === "string"
      ? meta.record.payload.model_provider
      : null;
  } finally {
    closeSync(fd);
  }
}

function patchFirstLineProviderInPlace(path: string, expectedId: string, provider: string): FirstLineProviderResult {
  if (!existsSync(path)) return "unsafe";
  const fd = openSync(path, "r+");
  try {
    const firstLine = readFirstRolloutLine(fd);
    if (firstLine === null) return "unsafe";
    const plan = planFirstLineProvider(firstLine, expectedId, provider);
    if (plan.state === "unsafe") return "unsafe";
    if (plan.state === "current") return "current";
    const out = Buffer.from(plan.patchedLine, "utf8");
    let offset = 0;
    while (offset < out.length) {
      offset += writeSync(fd, out, offset, out.length - offset, offset);
    }
    try { fsyncSync(fd); } catch { /* best-effort durability */ }
    return "patched";
  } finally {
    closeSync(fd);
  }
}

export type CodexHistoryProvider = "openai" | "opencodex";

export type CodexHistoryFailureReason = "busy" | "permission" | "integrity";

class CodexHistoryIntegrityError extends Error {
  constructor(
    code: string,
    readonly progress: { readonly rows: number; readonly files: number } = { rows: 0, files: 0 },
  ) {
    super(code);
    this.name = "CodexHistoryIntegrityError";
  }
}

function integrityFailureResult(error: CodexHistoryIntegrityError): CodexHistorySyncResult {
  return {
    rows: error.progress.rows,
    files: error.progress.files,
    failed: true,
    failureReason: "integrity",
  };
}

export interface CodexHistorySyncResult {
  /** Rows/files changed before a last-moment integrity race; may be nonzero with `failed`. */
  rows: number;
  files: number;
  ejectedRows?: number;
  /** Set when a lock/busy error survived retries and the sync was SKIPPED, not empty. */
  failed?: true;
  /** Why the retry budget was exhausted when `failed` is set. */
  failureReason?: CodexHistoryFailureReason;
}

interface ThreadRow {
  id: string;
  rollout_path: string;
  model_provider: string;
  source: string;
  has_user_event: number;
}

interface RestoreRowSnapshot extends ThreadRow {
  first_user_message: string | null;
}

interface ApplyRowSnapshot extends ThreadRow {
  first_user_message: string | null;
}

function hasFirstUserMessage(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export interface CodexHistoryVerifiedNoopProof {
  readonly kind: "verified-noop";
  readonly pendingRows: 0;
  readonly backupEntries: 0;
  readonly canonicalStateDbPath: string;
  readonly stateDbPresent: true;
  readonly canonicalBackupPath: string;
  readonly backupPresent: boolean;
}

export type CodexHistoryNoopSnapshot =
  | CodexHistoryVerifiedNoopProof
  | {
      readonly kind: "work-pending";
      readonly pendingRows: number;
      readonly backupEntries: number;
      readonly canonicalStateDbPath: string;
      readonly stateDbPresent: boolean;
      readonly canonicalBackupPath: string;
      readonly backupPresent: boolean;
    }
  | {
      readonly kind: "unknown";
      readonly pendingRows: null;
      readonly backupEntries: null;
      readonly canonicalStateDbPath: string;
      readonly stateDbPresent: boolean;
      readonly canonicalBackupPath: string;
      readonly backupPresent: boolean;
      readonly reason: "backup-path" | "database-absent" | "manifest-read" | "manifest-schema" | "manifest-foreign" | "database-query" | "snapshot-race";
    };

type StrictBackupInspection =
  | { readonly kind: "known"; readonly present: boolean; readonly entries: number; readonly fingerprint: string }
  | { readonly kind: "unknown"; readonly present: boolean; readonly reason: "manifest-read" | "manifest-schema" | "manifest-foreign";
      readonly failureReason?: "busy" | "permission" };

type StrictBackupRead =
  | {
      readonly kind: "known";
      readonly present: boolean;
      readonly manifest: CodexHistoryBackupManifest;
      readonly fingerprint: string;
    }
  | {
      readonly kind: "unknown";
      readonly present: true;
      readonly reason: "manifest-read" | "manifest-schema" | "manifest-foreign";
      readonly failureReason?: "busy" | "permission";
    };

let afterNoopPendingCountForTests: (() => void) | undefined;
let beforeHistoryBackupConsumeForTests: (() => void) | undefined;
let beforeStrictHistoryRolloutAppendForTests: (() => void) | undefined;
let afterStrictHistoryRolloutAppendForTests: (() => void) | undefined;
let beforeHistoryApplyTransactionForTests: (() => void) | undefined;

/** Test seam: runs after the pending count and before stability validation. */
export function setAfterNoopPendingCountForTests(hook: (() => void) | undefined): void {
  afterNoopPendingCountForTests = hook;
}

/** Test seam: runs after exact DB/rollout readback and before manifest fingerprint CAS. */
export function setBeforeHistoryBackupConsumeForTests(hook: (() => void) | undefined): void {
  beforeHistoryBackupConsumeForTests = hook;
}

/** Test seam: models a same-file append after strict snapshot validation but before our append. */
export function setBeforeStrictHistoryRolloutAppendForTests(hook: (() => void) | undefined): void {
  beforeStrictHistoryRolloutAppendForTests = hook;
}

/** Test seam: models a write/finalization failure after the strict append reached disk. */
export function setAfterStrictHistoryRolloutAppendForTests(hook: (() => void) | undefined): void {
  afterStrictHistoryRolloutAppendForTests = hook;
}

/** Test seam: runs after manifest snapshot publication and before apply's database CAS. */
export function setBeforeHistoryApplyTransactionForTests(hook: (() => void) | undefined): void {
  beforeHistoryApplyTransactionForTests = hook;
}

function readBackupStrict(path: string, stateDbPath: string): StrictBackupRead {
  let pathStat: ReturnType<typeof lstatSync>;
  try {
    pathStat = lstatSync(path);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code !== "ENOENT") {
      const failureReason = classifyRecoverableHistoryError(error);
      return {
        kind: "unknown",
        present: true,
        reason: "manifest-read",
        ...(failureReason === "busy" || failureReason === "permission" ? { failureReason } : {}),
      };
    }
    return {
      kind: "known",
      present: false,
      manifest: { version: 1, stateDbPath, entries: {} },
      fingerprint: "absent",
    };
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    return { kind: "unknown", present: true, reason: "manifest-read" };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const failureReason = classifyRecoverableHistoryError(error);
    return {
      kind: "unknown",
      present: true,
      reason: "manifest-read",
      ...(failureReason === "busy" || failureReason === "permission" ? { failureReason } : {}),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unknown", present: true, reason: "manifest-read" };
  }
  const validated = validateCodexHistoryBackupManifest(parsed, stateDbPath);
  if (!validated.ok) {
    return {
      kind: "unknown",
      present: true,
      reason: validated.reason === "foreign-database" ? "manifest-foreign" : "manifest-schema",
    };
  }
  return {
    kind: "known",
    present: true,
    manifest: validated.manifest,
    fingerprint: createHash("sha256").update(raw).digest("hex"),
  };
}

function inspectBackupForNoop(path: string, stateDbPath: string): StrictBackupInspection {
  const read = readBackupStrict(path, stateDbPath);
  return read.kind === "unknown"
    ? read
    : {
        kind: "known",
        present: read.present,
        entries: Object.keys(read.manifest.entries).length,
        fingerprint: read.fingerprint,
      };
}

function historyFileIdentity(path: string): string | null {
  try {
    const stat = statSync(path);
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
  } catch {
    return null;
  }
}

function readHistoryDataVersion(db: Database): number | null {
  const row = db.query<{ data_version: number }, []>("PRAGMA data_version").get();
  const value = row?.data_version;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function readBackup(path: string, stateDbPath: string): Extract<StrictBackupRead, { kind: "known" }> {
  const read = readBackupStrict(path, stateDbPath);
  if (read.kind === "unknown") {
    if (read.failureReason) {
      throw Object.assign(
        new Error(read.failureReason === "busy" ? "history backup is busy" : "history backup permission denied"),
        { code: read.failureReason === "busy" ? "EBUSY" : "EACCES" },
      );
    }
    throw new CodexHistoryIntegrityError(`history_backup_${read.reason.replaceAll("-", "_")}`);
  }
  return read;
}

function consumeBackupIfUnchanged(path: string, stateDbPath: string, expectedFingerprint: string): void {
  const current = readBackupStrict(path, stateDbPath);
  if (current.kind !== "known"
    || !current.present
    || current.fingerprint !== expectedFingerprint) {
    throw new CodexHistoryIntegrityError("history_backup_changed_during_restore");
  }
  unlinkSync(path);
}

function writeBackup(path: string, manifest: CodexHistoryBackupManifest, stateDbPath?: string): void {
  if (Object.keys(manifest.entries).length === 0) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFile(path, JSON.stringify({ ...manifest, stateDbPath: manifest.stateDbPath ?? stateDbPath }, null, 2) + "\n");
}

function rememberOriginal(manifest: CodexHistoryBackupManifest, row: ThreadRow): void {
  if (manifest.entries[row.id]) return;
  manifest.entries[row.id] = {
    id: row.id,
    rolloutPath: row.rollout_path,
    modelProvider: row.model_provider,
    source: row.source,
    hasUserEvent: Number(row.has_user_event) === 1 ? 1 : 0,
  };
}

function rowMatchesRestoreTuple(
  row: RestoreRowSnapshot,
  modelProvider: string,
  source: string,
  hasUserEvent: number,
): boolean {
  return row.model_provider === modelProvider
    && row.source === source
    && row.has_user_event === hasUserEvent;
}

function rowMatchesExpectedPostImage(row: RestoreRowSnapshot, entry: CodexHistoryBackupEntry): boolean {
  if (entry.modelProvider === "openai") {
    const postHasUserEvent = hasFirstUserMessage(row.first_user_message) ? 1 : entry.hasUserEvent;
    return rowMatchesRestoreTuple(row, "opencodex", entry.source, postHasUserEvent);
  }
  return hasFirstUserMessage(row.first_user_message)
    && (
      rowMatchesRestoreTuple(row, "opencodex", "cli", 1)
      // Older restore code coerced an opencodex/exec original into this exact tuple before
      // consuming its manifest. Accept that one known post-image so an interrupted old restore
      // can use its preserved first-line padding to recover exact provenance.
      || rowMatchesRestoreTuple(row, "openai", "cli", 1)
  );
}

interface RestoreRolloutSnapshot {
  readonly identity: string;
  readonly latestProvider: string;
  readonly latestSource: string;
}

function normalizedSessionMetaTuple(meta: ParsedSessionMeta): { provider: string; source: string } {
  const payload = meta.record.payload;
  return {
    provider: typeof payload.model_provider === "string" && payload.model_provider
      ? payload.model_provider
      : "openai",
    source: typeof payload.source === "string" && payload.source ? payload.source : "cli",
  };
}

function rolloutMatchesRestoreTuple(
  meta: ParsedSessionMeta,
  entry: CodexHistoryBackupEntry,
  provider: string,
  source: string,
): boolean {
  const tuple = normalizedSessionMetaTuple(meta);
  return meta.record.payload.id === entry.id
    && tuple.provider === provider
    && tuple.source === source;
}

function rolloutMatchesExpectedPostImage(meta: ParsedSessionMeta, entry: CodexHistoryBackupEntry): boolean {
  if (entry.modelProvider === "openai") {
    const tuple = normalizedSessionMetaTuple(meta);
    const rawSource = meta.record.payload.source;
    return meta.record.payload.id === entry.id
      && tuple.provider === "opencodex"
      // Older/native session_meta records can omit source even when SQLite identifies the
      // surface as vscode. Apply changes only the provider, so absence is a valid post-image;
      // restore appends the exact manifest source before consuming provenance.
      && ((typeof rawSource !== "string" || !rawSource) || tuple.source === entry.source);
  }
  return rolloutMatchesRestoreTuple(meta, entry, "opencodex", "cli")
    // Keep the same one-version recovery bridge as the database tuple check: older forced
    // restore code could already have produced openai/cli before consuming this manifest.
    || rolloutMatchesRestoreTuple(meta, entry, "openai", "cli");
}

function snapshotRolloutForRestore(entry: CodexHistoryBackupEntry): RestoreRolloutSnapshot {
  const identityBefore = historyFileIdentity(entry.rolloutPath);
  if (identityBefore === null) {
    throw new CodexHistoryIntegrityError("history_backup_rollout_unrestorable");
  }
  const latest = readLatestSessionMeta(entry.rolloutPath);
  if (!latest
    || (!rolloutMatchesRestoreTuple(latest, entry, entry.modelProvider, entry.source)
      && !rolloutMatchesExpectedPostImage(latest, entry))) {
    throw new CodexHistoryIntegrityError("history_backup_rollout_postimage_mismatch");
  }
  const firstProvider = readFirstLineProviderValue(entry.rolloutPath, entry.id);
  if (firstProvider !== "openai" && firstProvider !== "opencodex") {
    throw new CodexHistoryIntegrityError("history_backup_rollout_postimage_mismatch");
  }
  if (inspectFirstLineProvider(entry.rolloutPath, entry.id, entry.modelProvider) === "unsafe") {
    throw new CodexHistoryIntegrityError("history_backup_rollout_unrestorable");
  }
  if (historyFileIdentity(entry.rolloutPath) !== identityBefore) {
    throw new CodexHistoryIntegrityError("history_backup_rollout_changed_during_restore");
  }
  const tuple = normalizedSessionMetaTuple(latest);
  return {
    identity: identityBefore,
    latestProvider: tuple.provider,
    latestSource: tuple.source,
  };
}

interface RestoreTargetPreflight {
  readonly snapshots: Map<string, RestoreRowSnapshot>;
  readonly rolloutSnapshots: Map<string, RestoreRolloutSnapshot>;
}

/**
 * Read-only authority shared by restore and status/doctor. Every manifest entry must still
 * identify either its exact target tuple or the one OpenCodex post-image, and its rollout
 * must be present, stable, same-id, and durably restorable before callers call it pending.
 */
function preflightRestoreTargets(
  getCurrent: (id: string) => RestoreRowSnapshot | null,
  entries: CodexHistoryBackupEntry[],
): RestoreTargetPreflight {
  const snapshots = preflightRestoreRows(getCurrent, entries);
  const rolloutSnapshots = new Map<string, RestoreRolloutSnapshot>();
  for (const entry of entries) {
    // Validate every rollout before the first mutation. A later missing, foreign, or
    // unpatchable entry must not leave an earlier file partially restored.
    rolloutSnapshots.set(entry.id, snapshotRolloutForRestore(entry));
  }
  return { snapshots, rolloutSnapshots };
}

/** Cheap manifest-to-database authority check used by recurring no-op probes. */
function preflightRestoreRows(
  getCurrent: (id: string) => RestoreRowSnapshot | null,
  entries: CodexHistoryBackupEntry[],
): Map<string, RestoreRowSnapshot> {
  const snapshots = new Map<string, RestoreRowSnapshot>();
  for (const entry of entries) {
    const row = getCurrent(entry.id);
    if (!row || typeof row.rollout_path !== "string" || !sameCodexHistoryPath(row.rollout_path, entry.rolloutPath)) {
      throw new CodexHistoryIntegrityError("history_backup_target_mismatch");
    }
    if (!rowMatchesRestoreTuple(row, entry.modelProvider, entry.source, entry.hasUserEvent)
      && !rowMatchesExpectedPostImage(row, entry)) {
      throw new CodexHistoryIntegrityError("history_backup_postimage_mismatch");
    }
    snapshots.set(entry.id, row);
  }
  return snapshots;
}

function assertRestoreReadback(
  getCurrent: (id: string) => RestoreRowSnapshot | null,
  entries: CodexHistoryBackupEntry[],
): void {
  for (const entry of entries) {
    const row = getCurrent(entry.id);
    if (!row
      || !sameCodexHistoryPath(row.rollout_path, entry.rolloutPath)
      || !rowMatchesRestoreTuple(row, entry.modelProvider, entry.source, entry.hasUserEvent)) {
      throw new CodexHistoryIntegrityError("history_backup_database_readback_mismatch");
    }
    const latest = readLatestSessionMeta(entry.rolloutPath);
    if (inspectFirstLineProvider(entry.rolloutPath, entry.id, entry.modelProvider) !== "current"
      || !latest
      || !rolloutMatchesRestoreTuple(latest, entry, entry.modelProvider, entry.source)) {
      throw new CodexHistoryIntegrityError("history_backup_rollout_readback_mismatch");
    }
  }
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
export function readLatestSessionMeta(path: string): ParsedSessionMeta | null {
  const raw = readFileSync(path, "utf8");
  return readLatestSessionMetaFromText(raw);
}

function readLatestSessionMetaFromText(raw: string): ParsedSessionMeta | null {
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

function readLatestSessionMetaForIdFromText(raw: string, expectedId: string): ParsedSessionMeta | null {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes("\"session_meta\"")) continue;
    const meta = parseSessionMetaLine(line);
    if (meta?.record.payload.id === expectedId) return meta;
  }
  return null;
}

function compensateConcurrentSessionMetaAppend(
  path: string,
  expectedId: string,
  appended: Buffer,
  minimumOffset: number,
): void {
  try {
    const raw = readFileSync(path);
    const ownOffset = raw.lastIndexOf(appended);
    if (ownOffset < minimumOffset) return;
    const withoutOwnAppend = Buffer.concat([
      raw.subarray(0, ownOffset),
      raw.subarray(ownOffset + appended.length),
    ]).toString("utf8");
    const prior = readLatestSessionMetaForIdFromText(withoutOwnAppend, expectedId);
    if (prior) appendRolloutLine(path, JSON.stringify(prior.record));
  } catch {
    // The caller reports an integrity conflict and retains the manifest. Compensation is
    // best-effort because a second write failure must not erase the original failure evidence.
  }
}

/**
 * Fields needed to re-insert a production-shaped `threads` row from a rollout JSONL when a
 * Phase-2 quarantine predates full `satellite-backup.json` thread snapshots.
 *
 * Uses the same last-writer-wins `session_meta` fold as {@link readLatestSessionMeta}, plus the
 * first user-message preview (codex-rs `list.rs` / `EventMsg::UserMessage` path).
 */
export interface RolloutThreadFields {
  id: string;
  modelProvider: string;
  source: string;
  firstUserMessage: string;
  hasUserEvent: number;
  cwd?: string;
  historyMode?: string;
  cliVersion?: string;
}

function textFromContentParts(content: unknown): string | null {
  if (typeof content === "string" && content.trim()) return content.trim();
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (typeof p.text === "string" && p.text.trim()) parts.push(p.text.trim());
    else if (typeof p.input_text === "string" && p.input_text.trim()) parts.push(p.input_text.trim());
  }
  const joined = parts.join("\n").trim();
  return joined || null;
}

/** Extract the first user-message preview from a rollout line, or null. */
function extractUserMessagePreview(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { type?: unknown; payload?: unknown };
  const payload = record.payload;
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  if (record.type === "event_msg") {
    // codex-rs EventMsg::UserMessage — payload.type is "user_message" (or omitted in fixtures).
    if (p.type === "user_message" || typeof p.message === "string") {
      if (typeof p.message === "string" && p.message.trim()) return p.message.trim();
      const fromContent = textFromContentParts(p.content);
      if (fromContent) return fromContent;
    }
    return null;
  }

  if (record.type === "response_item") {
    if (p.type === "message" && p.role === "user") {
      return textFromContentParts(p.content);
    }
  }
  return null;
}

/**
 * Reconstruct thread identity + listing fields from a staged/restored rollout JSONL.
 * Returns null when the file is missing or has no parseable `session_meta`.
 *
 * Accepts plain `.jsonl` or a lone `.jsonl.zst` (legacy Phase-2 quarantine). Compressed
 * rollouts are decompressed in memory with {@link MAX_ROLLOUT_ZST_DECOMPRESSED_BYTES};
 * no decompressed copy is written to disk.
 */
export function readThreadFieldsFromRollout(path: string): RolloutThreadFields | null {
  if (!path || !existsSync(path)) return null;
  let raw: string;
  try {
    raw = path.endsWith(".zst")
      ? decompressRolloutZstUtf8(path)
      : readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseThreadFieldsFromRolloutText(raw);
}

function decompressRolloutZstUtf8(
  path: string,
  maxBytes: number = MAX_ROLLOUT_ZST_DECOMPRESSED_BYTES,
): string {
  const compressed = readFileSync(path);
  const decoded = zstdDecompressSync(compressed as Uint8Array<ArrayBuffer>, {
    maxOutputLength: maxBytes,
  });
  if (decoded.byteLength > maxBytes) {
    throw new Error("rollout_zst_too_large");
  }
  return new TextDecoder().decode(decoded);
}

function parseThreadFieldsFromRolloutText(raw: string): RolloutThreadFields | null {
  const lines = raw.split("\n");
  let latest: ParsedSessionMeta | null = null;
  let firstUserMessage = "";
  for (const line of lines) {
    if (!line) continue;
    if (line.includes("\"session_meta\"")) {
      const meta = parseSessionMetaLine(line);
      if (meta) latest = meta;
    }
    if (!firstUserMessage) {
      const preview = extractUserMessagePreview(line);
      if (preview) firstUserMessage = preview;
    }
  }
  if (!latest) return null;
  const payload = latest.record.payload;
  const id = typeof payload.id === "string" ? payload.id : "";
  if (!id) return null;
  const modelProvider = typeof payload.model_provider === "string" && payload.model_provider
    ? payload.model_provider
    : "openai";
  const source = typeof payload.source === "string" && payload.source
    ? payload.source
    : "cli";
  return {
    id,
    modelProvider,
    source,
    firstUserMessage,
    hasUserEvent: firstUserMessage.trim() ? 1 : 0,
    ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
    ...(typeof payload.history_mode === "string" ? { historyMode: payload.history_mode } : {}),
    ...(typeof payload.cli_version === "string" ? { cliVersion: payload.cli_version } : {}),
  };
}

/**
 * Make a thread's rollout reflect a provider/source change by APPENDING a new `session_meta` line,
 * rather than rewriting line 1. The appended line clones the latest metadata payload (so no field
 * is accidentally reset to empty) and applies only the requested changes. `durableProvider`
 * reports whether line 1 already carried (or was safely patched to) the requested provider.
 */
interface SessionMetaUpdateResult {
  changed: boolean;
  durableProvider: boolean;
  conflict?: true;
}

function updateSessionMeta(
  path: string,
  expectedId: string,
  patch: { provider?: string; source?: string },
  options: {
    requireDurableProvider?: boolean;
    expectedFileIdentity?: string;
    expectedLatestProvider?: string;
    expectedLatestSource?: string;
  } = {},
): SessionMetaUpdateResult {
  if (!path || !existsSync(path)) return { changed: false, durableProvider: false };
  if (options.expectedFileIdentity !== undefined
    && historyFileIdentity(path) !== options.expectedFileIdentity) {
    return { changed: false, durableProvider: false, conflict: true };
  }

  const latest = readLatestSessionMeta(path);
  if (!latest) return { changed: false, durableProvider: false };
  const record = latest.record;

  // The app ignores `session_meta` lines whose payload id != the canonical thread id
  // (codex-rs `apply_session_meta_from_item`). Forked rollouts can embed a source session's
  // metadata, so an id-mismatched latest line means we'd be cloning the wrong thread's meta and
  // appending a line the app would discard. Skip rather than write a no-op/misleading line.
  const payloadId = record.payload.id;
  if (typeof payloadId !== "string" || payloadId !== expectedId) {
    return { changed: false, durableProvider: false };
  }
  const latestProvider = typeof record.payload.model_provider === "string" && record.payload.model_provider
    ? record.payload.model_provider
    : "openai";
  const latestSource = typeof record.payload.source === "string" && record.payload.source
    ? record.payload.source
    : "cli";
  if ((options.expectedLatestProvider !== undefined && latestProvider !== options.expectedLatestProvider)
    || (options.expectedLatestSource !== undefined && latestSource !== options.expectedLatestSource)
    || (options.expectedFileIdentity !== undefined
      && historyFileIdentity(path) !== options.expectedFileIdentity)) {
    return { changed: false, durableProvider: false, conflict: true };
  }

  const previousRecord = JSON.stringify(record);
  let changed = false;
  if (patch.provider !== undefined && record.payload.model_provider !== patch.provider) {
    record.payload.model_provider = patch.provider;
    changed = true;
  }
  if (patch.source !== undefined && record.payload.source !== patch.source) {
    record.payload.source = patch.source;
    changed = true;
  }
  const strictRestore = options.expectedFileIdentity !== undefined;
  if (strictRestore) {
    if (historyFileIdentity(path) !== options.expectedFileIdentity) {
      return { changed: false, durableProvider: false, conflict: true };
    }

    let appended: Buffer | null = null;
    let beforeSize = 0;
    if (changed) {
      beforeSize = statSync(path).size;
      beforeStrictHistoryRolloutAppendForTests?.();
      record.timestamp = new Date().toISOString();
      appended = appendRolloutLine(path, JSON.stringify(record));
      afterStrictHistoryRolloutAppendForTests?.();
      let cleanAppend = false;
      try {
        const raw = readFileSync(path);
        cleanAppend = raw.length === beforeSize + appended.length
          && raw.subarray(beforeSize).equals(appended);
      } catch {
        cleanAppend = false;
      }
      if (!cleanAppend) {
        compensateConcurrentSessionMetaAppend(path, expectedId, appended, beforeSize);
        return { changed: true, durableProvider: false, conflict: true };
      }
    }

    let firstLine: FirstLineProviderResult = "current";
    if (patch.provider !== undefined) {
      try {
        firstLine = patchFirstLineProviderInPlace(path, expectedId, patch.provider);
      } catch {
        firstLine = "unsafe";
      }
    }
    if (options.requireDurableProvider && firstLine === "unsafe") {
      // Restore the pre-operation last-writer-wins tuple after an append succeeded but the
      // first-line durability repair failed. The extra lines remain audit evidence; the manifest
      // remains authoritative and the retry cannot mistake this for convergence.
      if (appended) appendRolloutLine(path, previousRecord);
      return {
        changed: changed || historyFileIdentity(path) !== options.expectedFileIdentity,
        durableProvider: false,
      };
    }
    return {
      changed: changed || firstLine === "patched",
      durableProvider: firstLine !== "unsafe",
    };
  }

  // Cover Codex's *other* provider reader: `read_session_meta_line` reads only line 1, and the
  // app clones it when writing later git/memory-mode metadata. Appending alone leaves a stale
  // line-1 provider that the clone would re-append. Exact restore requires this repair before it
  // may update SQLite or consume the only provenance manifest; forward routing remains best-effort.
  let firstLine: FirstLineProviderResult = "current";
  if (patch.provider !== undefined) {
    try {
      firstLine = patchFirstLineProviderInPlace(path, expectedId, patch.provider);
    } catch {
      firstLine = "unsafe";
    }
    if (options.requireDurableProvider && firstLine === "unsafe") {
      return { changed: false, durableProvider: false };
    }
  }

  const firstLineChanged = firstLine === "patched";
  if (!changed) return { changed: firstLineChanged, durableProvider: firstLine !== "unsafe" };

  // Forward/legacy mode remains best-effort. Strict manifest restore uses the CAS-style append
  // branch above so a concurrent same-id provider decision cannot be overwritten.
  record.timestamp = new Date().toISOString();
  appendRolloutLine(path, JSON.stringify(record));
  return { changed: true, durableProvider: firstLine !== "unsafe" };
}

function relabelAllRoutedHistoryToOpenai(db: Database): { rows: number; files: number } {
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
      }).changed) files++;
    } catch {
      /* explicit legacy recovery still relabels the DB when an old rollout is missing */
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

export function classifyRecoverableHistoryError(error: unknown): CodexHistoryFailureReason | null {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (code === "SQLITE_BUSY"
    || code === "SQLITE_LOCKED"
    || code === "EBUSY"
    || message.includes("database is locked")
    || message.includes("database is busy")
    || message.includes("resource busy")) return "busy";
  if (code === "EPERM"
    || code === "EACCES"
    || message.includes("operation not permitted")
    || message.includes("permission denied")) return "permission";
  return null;
}

export function isRecoverableHistoryError(error: unknown): boolean {
  return classifyRecoverableHistoryError(error) !== null;
}

const HISTORY_RETRY_DELAY_MS = 500;
const HISTORY_RETRY_ATTEMPTS = 2;

/**
 * Run a history mutation with one retry across recoverable lock/busy errors (the app's own
 * connection holds `state_5.sqlite` in WAL with a 5 s busy_timeout; a transient writer
 * usually clears within that window). Returns null when both attempts hit a recoverable
 * error — callers surface that as `failed: true` instead of a silent no-op. Hard errors
 * (corruption, programming bugs) still throw.
 */
function withHistoryRetryResult<T>(fn: () => T, io: { sleepFn?: (ms: number) => void; attempts?: number; delayMs?: number } = {}):
  | { ok: true; value: T }
  | { ok: false; reason: CodexHistoryFailureReason } {
  const sleepFn = io.sleepFn ?? Bun.sleepSync;
  const attempts = Math.max(1, io.attempts ?? HISTORY_RETRY_ATTEMPTS);
  const delayMs = io.delayMs ?? HISTORY_RETRY_DELAY_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return { ok: true, value: fn() };
    } catch (error) {
      const reason = classifyRecoverableHistoryError(error);
      if (!reason) throw error;
      if (attempt >= attempts - 1) return { ok: false, reason };
      try { sleepFn(delayMs); } catch { /* sleep is best-effort */ }
    }
  }
}

export function withHistoryRetry<T>(fn: () => T, io: { sleepFn?: (ms: number) => void; attempts?: number; delayMs?: number } = {}): T | null {
  const result = withHistoryRetryResult(fn, io);
  return result.ok ? result.value : null;
}

/**
 * True when a READONLY probe proves the native-direction restore would be a no-op:
 * the history database is readable and the backup manifest has no restore entries. Bare
 * opencodex-tagged rows are not actionable: without a manifest their original provider is
 * unknown, so only the explicit legacy recovery command may relabel them. Used to skip the
 * write-open entirely in the Design B steady state — on Windows the Codex app holds
 * `state_5.sqlite` (WAL, busy_timeout 5s), so an unnecessary write open can stall for
 * seconds and surface a false lock warning, while WAL always admits readers. A failed
 * probe (locked even for readers / schema drift) returns false so callers fall through
 * to the write attempt and keep today's behavior for genuinely unknown state.
 */
function openaiRestoreIsNoop(stateDbPath: string, backupPath: string): boolean {
  const pending = countPendingOpencodexHistory(stateDbPath, backupPath, {
    validateRestoreTargets: false,
  });
  return !pending.failed && pending.pendingRows === 0 && pending.backupEntries === 0;
}

export function syncCodexHistoryProvider(
  provider: CodexHistoryProvider,
  stateDbPath = resolveCodexStateDbPath(),
  backupPath = historyBackupPathFor(stateDbPath),
  opts: { skipWhenProvablyNoop?: boolean } = {},
): CodexHistorySyncResult {
  // Opt-in steady-state gate (Design B loopback callers only): default semantics of
  // this exported API are unchanged — legacy stop/restore paths never pass the flag.
  if (opts.skipWhenProvablyNoop && provider === "openai" && existsSync(stateDbPath)
    && openaiRestoreIsNoop(stateDbPath, backupPath)) {
    return { rows: 0, files: 0 };
  }
  try {
    const retried = withHistoryRetryResult(() => syncCodexHistoryProviderUnsafe(provider, stateDbPath, backupPath));
    return retried.ok ? retried.value : { rows: 0, files: 0, failed: true, failureReason: retried.reason };
  } catch (error) {
    if (error instanceof CodexHistoryIntegrityError) {
      return integrityFailureResult(error);
    }
    throw error;
  }
}

function syncCodexHistoryProviderUnsafe(provider: CodexHistoryProvider, stateDbPath: string, backupPath: string): CodexHistorySyncResult {
  if (!existsSync(stateDbPath)) {
    const backup = readBackup(backupPath, stateDbPath);
    if (provider === "openai" && Object.keys(backup.manifest.entries).length > 0) {
      throw new CodexHistoryIntegrityError("history_state_database_missing");
    }
    return { rows: 0, files: 0 };
  }
  if (provider === "openai") return restoreCodexHistoryProvider(stateDbPath, backupPath);

  const db = openStateDb(stateDbPath);
  try {
    const placeholders = CODEX_HISTORY_RESUMABLE_SOURCES.map(() => "?").join(",");
    const openaiRows = db
      .query<ApplyRowSnapshot, string[]>(`
        SELECT id, rollout_path, model_provider, source, has_user_event, first_user_message
        FROM threads
        WHERE model_provider = 'openai'
          AND source IN (${placeholders})
      `)
      .all(...CODEX_HISTORY_RESUMABLE_SOURCES);
    const execRows = db
      .query<ApplyRowSnapshot, []>(`
        SELECT id, rollout_path, model_provider, source, has_user_event, first_user_message
        FROM threads
        WHERE model_provider = 'opencodex'
          AND source = 'exec'
          AND trim(coalesce(first_user_message, '')) != ''
      `)
      .all();

    const manifest = readBackup(backupPath, stateDbPath).manifest;
    for (const row of [...openaiRows, ...execRows]) rememberOriginal(manifest, row);
    writeBackup(backupPath, manifest, stateDbPath);

    let files = 0;
    const update = db.transaction(() => {
      const routeOpenai = db.query(`
        UPDATE threads
        SET model_provider = 'opencodex',
            has_user_event = ?
        WHERE id = ?
          AND rollout_path = ?
          AND model_provider = ?
          AND source = ?
          AND has_user_event = ?
          AND first_user_message IS ?
      `);
      const routeExec = db.query(`
        UPDATE threads
        SET source = 'cli',
            has_user_event = 1
        WHERE id = ?
          AND rollout_path = ?
          AND model_provider = ?
          AND source = ?
          AND has_user_event = ?
          AND first_user_message IS ?
          AND trim(coalesce(first_user_message, '')) != ''
      `);
      // CAS only the rows that were recorded in this manifest. A thread inserted after the
      // snapshot must stay native rather than becoming an untracked bare routed row.
      for (const row of openaiRows) {
        const targetEvent = hasFirstUserMessage(row.first_user_message) ? 1 : row.has_user_event;
        const result = routeOpenai.run(
          targetEvent,
          row.id,
          row.rollout_path,
          row.model_provider,
          row.source,
          row.has_user_event,
          row.first_user_message,
        );
        if (result.changes !== 1) {
          throw new CodexHistoryIntegrityError("history_apply_database_changed_during_route");
        }
      }
      for (const row of execRows) {
        const result = routeExec.run(
          row.id,
          row.rollout_path,
          row.model_provider,
          row.source,
          row.has_user_event,
          row.first_user_message,
        );
        if (result.changes !== 1) {
          throw new CodexHistoryIntegrityError("history_apply_database_changed_during_route");
        }
      }

      // File metadata remains best-effort, but only after every database CAS matched. Thus a
      // stale snapshot or a newly inserted row cannot be routed before its provenance exists.
      for (const row of openaiRows) {
        try {
          if (updateSessionMeta(row.rollout_path, row.id, { provider: "opencodex" }).changed) files++;
        } catch {
          /* keep DB migration moving; the manifest still carries exact original metadata */
        }
      }
      for (const row of execRows) {
        try {
          if (updateSessionMeta(row.rollout_path, row.id, { source: "cli" }).changed) files++;
        } catch {
          /* keep DB migration moving; the manifest still carries exact original metadata */
        }
      }
    });
    try {
      beforeHistoryApplyTransactionForTests?.();
      update();
    } catch (error) {
      if (files > 0) {
        throw new CodexHistoryIntegrityError("history_apply_partial_route", { rows: 0, files });
      }
      throw error;
    }

    return { rows: openaiRows.length + execRows.length, files };
  } finally {
    db.close();
  }
}

function restoreCodexHistoryProvider(stateDbPath: string, backupPath: string): CodexHistorySyncResult {
  const backup = readBackup(backupPath, stateDbPath);
  const manifest = backup.manifest;
  const entries = Object.values(manifest.entries);

  const db = openStateDb(stateDbPath);
  try {
    if (entries.length === 0) return { rows: 0, files: 0 };

    // Validate the whole manifest-to-database target set before touching a rollout. Only the
    // OpenCodex post-image (or an already-restored target from an interrupted retry) is owned by
    // this manifest. Any other tuple is a newer/foreign provider decision and must win.
    const current = db.query<RestoreRowSnapshot, [string]>(`
      SELECT id, rollout_path, model_provider, source, has_user_event, first_user_message
      FROM threads WHERE id = ?
    `);
    const { snapshots, rolloutSnapshots } = preflightRestoreTargets(id => current.get(id), entries);

    let files = 0;
    const restore = db.transaction(() => {
      const update = db.query(`
        UPDATE threads
        SET model_provider = ?,
            source = ?,
            has_user_event = ?
        WHERE id = ?
          AND rollout_path = ?
          AND model_provider = ?
          AND source = ?
          AND has_user_event = ?
          AND first_user_message IS ?
      `);
      for (const entry of entries) {
        const before = snapshots.get(entry.id);
        if (!before) throw new CodexHistoryIntegrityError("history_backup_snapshot_missing");
        const result = update.run(
          entry.modelProvider,
          entry.source,
          entry.hasUserEvent,
          entry.id,
          before.rollout_path,
          before.model_provider,
          before.source,
          before.has_user_event,
          before.first_user_message,
        );
        if (result.changes !== 1) {
          throw new CodexHistoryIntegrityError("history_backup_database_changed_during_restore");
        }
      }
      // Only after every database CAS matched may a rollout move. Keeping the SQLite
      // transaction open means a file-side refusal rolls the database back, while the manifest
      // remains the durable retry journal for an exceptional I/O failure.
      for (const entry of entries) {
        const before = rolloutSnapshots.get(entry.id);
        if (!before) throw new CodexHistoryIntegrityError("history_backup_rollout_snapshot_missing");
        let updated: SessionMetaUpdateResult;
        try {
          updated = updateSessionMeta(
            entry.rolloutPath,
            entry.id,
            { provider: entry.modelProvider, source: entry.source },
            {
              requireDurableProvider: true,
              expectedFileIdentity: before.identity,
              expectedLatestProvider: before.latestProvider,
              expectedLatestSource: before.latestSource,
            },
          );
        } catch (error) {
          if (historyFileIdentity(entry.rolloutPath) !== before.identity) files++;
          throw error;
        }
        if (updated.changed) files++;
        if (updated.conflict) {
          throw new CodexHistoryIntegrityError("history_backup_rollout_changed_during_restore");
        }
        if (!updated.durableProvider) {
          throw new CodexHistoryIntegrityError("history_backup_rollout_unrestorable");
        }
      }
    });
    try {
      restore();
    } catch (error) {
      if (files > 0) {
        throw new CodexHistoryIntegrityError("history_backup_partial_restore", { rows: 0, files });
      }
      throw error;
    }

    try {
      const getCurrent = (id: string) => current.get(id);
      assertRestoreReadback(getCurrent, entries);
      beforeHistoryBackupConsumeForTests?.();
      // The hook models the exact last-moment race: neither a newer database decision nor a
      // same-id foreign session_meta may be hidden by deleting the only provenance manifest.
      assertRestoreReadback(getCurrent, entries);
      consumeBackupIfUnchanged(backupPath, stateDbPath, backup.fingerprint);
    } catch (error) {
      if (error instanceof CodexHistoryIntegrityError) {
        throw new CodexHistoryIntegrityError(error.message, { rows: entries.length, files });
      }
      const failureReason = classifyRecoverableHistoryError(error);
      if (failureReason) {
        return {
          rows: entries.length,
          files,
          failed: true,
          failureReason,
        };
      }
      // Once exact targets were written, an unclassified finalization failure is an
      // applied-but-not-converged integrity state. Preserve that progress instead of
      // reporting a zero-change failure that invites an unsafe blind retry.
      throw new CodexHistoryIntegrityError("history_backup_finalization_failed", {
        rows: entries.length,
        files,
      });
    }
    return { rows: entries.length, files };
  } finally {
    db.close();
  }
}

export function restoreLegacyOpenaiHistory(stateDbPath = resolveCodexStateDbPath()): CodexHistorySyncResult {
  if (!existsSync(stateDbPath)) return { rows: 0, files: 0 };
  const retried = withHistoryRetryResult(() => {
    const db = openStateDb(stateDbPath);
    try {
      return relabelAllRoutedHistoryToOpenai(db);
    } finally {
      db.close();
    }
  });
  return retried.ok ? retried.value : { rows: 0, files: 0, failed: true, failureReason: retried.reason };
}

/**
 * One-time Design-B migration: restore only manifest-backed originals. Untracked
 * opencodex-tagged threads have unknown provider provenance and remain routed unless the
 * user explicitly invokes legacy OpenAI recovery. Thin wrapper over the restore path with a
 * configurable retry budget — the daemon migration guardian uses `{ attempts: 1 }`
 * per tick so a locked DB never stalls the event loop beyond one sqlite busy wait.
 */
export function migrateHistoryToOpenai(
  stateDbPath = resolveCodexStateDbPath(),
  backupPath = historyBackupPathFor(stateDbPath),
  opts: { attempts?: number; delayMs?: number; sleepFn?: (ms: number) => void } = {},
): CodexHistorySyncResult {
  // Steady-state gate: this migration is Design-B-specific (inject + guardian callers),
  // and after the one-time migration every start would otherwise write-open the DB for
  // nothing. A missing DB with a leftover backup manifest does NOT satisfy the gate
  // (backupEntries > 0), so the guardian's fresh-reinstall re-count protection holds.
  if (openaiRestoreIsNoop(stateDbPath, backupPath)) return { rows: 0, files: 0 };
  try {
    const retried = withHistoryRetryResult(() => syncCodexHistoryProviderUnsafe("openai", stateDbPath, backupPath), opts);
    return retried.ok ? retried.value : { rows: 0, files: 0, failed: true, failureReason: retried.reason };
  } catch (error) {
    if (error instanceof CodexHistoryIntegrityError) {
      return integrityFailureResult(error);
    }
    throw error;
  }
}

/**
 * Captures no-op evidence while the caller holds the history serialization
 * lock H. This function does not acquire H itself. Unknown or foreign backup
 * state is never collapsed into an empty manifest.
 */
export function snapshotCodexHistoryNoop(
  stateDbPath: string,
  backupPath: string,
): CodexHistoryNoopSnapshot {
  const canonicalStateDbPath = resolve(stateDbPath);
  const canonicalBackupPath = resolve(backupPath);
  const stateDbPresent = existsSync(stateDbPath);
  const backupPresent = existsSync(backupPath);
  const base = { canonicalStateDbPath, stateDbPresent, canonicalBackupPath, backupPresent };
  if (!sameCodexHistoryPath(backupPath, historyBackupPathFor(stateDbPath))) {
    return { kind: "unknown", pendingRows: null, backupEntries: null, ...base, reason: "backup-path" };
  }
  const backup = inspectBackupForNoop(backupPath, stateDbPath);
  if (backup.kind === "unknown") {
    return { kind: "unknown", pendingRows: null, backupEntries: null, ...base, reason: backup.reason };
  }
  if (!stateDbPresent) {
    return backup.entries > 0
      ? { kind: "work-pending", pendingRows: 0, backupEntries: backup.entries, ...base }
      : { kind: "unknown", pendingRows: null, backupEntries: null, ...base, reason: "database-absent" };
  }
  const stateDbIdentity = historyFileIdentity(stateDbPath);
  if (stateDbIdentity === null) {
    return { kind: "unknown", pendingRows: null, backupEntries: null, ...base, reason: "snapshot-race" };
  }
  let monitor: Database | undefined;
  try {
    monitor = new Database(stateDbPath, { readonly: true });
    monitor.exec("PRAGMA busy_timeout = 100");
    const dataVersionBefore = readHistoryDataVersion(monitor);
    if (dataVersionBefore === null) {
      return { kind: "unknown", pendingRows: null, backupEntries: null, ...base, reason: "database-query" };
    }
    const pending = countPendingOpencodexHistory(stateDbPath, backupPath, {
      validateRestoreTargets: false,
    });
    if (pending.failed) {
      return { kind: "unknown", pendingRows: null, backupEntries: null, ...base, reason: "database-query" };
    }
    afterNoopPendingCountForTests?.();
    const backupAfter = inspectBackupForNoop(backupPath, stateDbPath);
    if (backupAfter.kind === "unknown") {
      return { kind: "unknown", pendingRows: null, backupEntries: null, ...base, reason: backupAfter.reason };
    }
    const dataVersionAfter = readHistoryDataVersion(monitor);
    if (dataVersionAfter === null) {
      return { kind: "unknown", pendingRows: null, backupEntries: null, ...base, reason: "database-query" };
    }
    if (dataVersionAfter !== dataVersionBefore
      || pending.backupEntries !== backup.entries
      || backupAfter.entries !== backup.entries
      || backupAfter.present !== backup.present
      || backupAfter.fingerprint !== backup.fingerprint
      || historyFileIdentity(stateDbPath) !== stateDbIdentity
      || existsSync(stateDbPath) !== stateDbPresent
      || existsSync(backupPath) !== backupPresent) {
      return { kind: "unknown", pendingRows: null, backupEntries: null, ...base, reason: "snapshot-race" };
    }
    return pending.pendingRows === 0 && backup.entries === 0
      ? { kind: "verified-noop", pendingRows: 0, backupEntries: 0, ...base, stateDbPresent: true }
      : { kind: "work-pending", pendingRows: pending.pendingRows, backupEntries: backup.entries, ...base };
  } catch {
    return { kind: "unknown", pendingRows: null, backupEntries: null, ...base, reason: "database-query" };
  } finally {
    try {
      monitor?.close();
    } catch {
      // Read-only monitor cleanup cannot make an uncertain snapshot authoritative.
    }
  }
}

export interface PendingHistoryCount {
  /** Compatibility field; bare routed rows are never automatic restore work. */
  pendingRows: number;
  /** Entries still recorded in the backup manifest (restore targets). */
  backupEntries: number;
  /** Set when the DB/manifest could not be read or their bound identity is invalid. */
  failed?: true;
  /** Distinguishes retryable contention/access from a manifest or target that needs review. */
  failureReason?: CodexHistoryFailureReason;
}

/**
 * Read-only migration progress probe for the guardian and `ocx doctor`. Opens sqlite
 * readonly with a SHORT busy timeout so a locked DB cannot stall a daemon tick. Only a
 * valid, database-bound backup manifest is actionable work; bare routed rows remain
 * untouched because their original provider is not known. Operator diagnostics keep the
 * default deep rollout validation. Recurring no-op probes explicitly opt out because any
 * nonempty manifest already prevents a no-op and the mutation path always preflights files.
 */
export function countPendingOpencodexHistory(
  stateDbPath = resolveCodexStateDbPath(),
  backupPath = historyBackupPathFor(stateDbPath),
  opts: { validateRestoreTargets?: boolean } = {},
): PendingHistoryCount {
  const backup = readBackupStrict(backupPath, stateDbPath);
  if (backup.kind === "unknown") {
    return {
      pendingRows: 0,
      backupEntries: 0,
      failed: true,
      failureReason: backup.failureReason ?? "integrity",
    };
  }
  const entries = Object.values(backup.manifest.entries);
  const backupEntries = entries.length;

  if (!existsSync(stateDbPath)) {
    return backupEntries > 0
      ? { pendingRows: 0, backupEntries, failed: true, failureReason: "integrity" }
      : { pendingRows: 0, backupEntries };
  }
  try {
    const db = new Database(stateDbPath, { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 100");
      // Prove the expected history schema is readable without counting unowned routed rows.
      db.query("SELECT 1 FROM threads LIMIT 1").get();
      if (entries.length > 0) {
        const current = db.query<RestoreRowSnapshot, [string]>(`
          SELECT id, rollout_path, model_provider, source, has_user_event, first_user_message
          FROM threads WHERE id = ?
        `);
        if (opts.validateRestoreTargets === false) {
          preflightRestoreRows(id => current.get(id), entries);
        } else {
          preflightRestoreTargets(id => current.get(id), entries);
        }
      }
      return { pendingRows: 0, backupEntries };
    } finally {
      db.close();
    }
  } catch (error) {
    const reason = classifyRecoverableHistoryError(error);
    if (reason) return { pendingRows: 0, backupEntries, failed: true, failureReason: reason };
    // Schema drift (e.g. a future codex renames the table) is a "cannot know" too, not a crash.
    return { pendingRows: 0, backupEntries, failed: true, failureReason: "integrity" };
  }
}
