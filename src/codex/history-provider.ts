import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { Database } from "bun:sqlite";
import { resolveCodexStateDbPath } from "./paths";
import { atomicWriteFile, getConfigDir } from "../config";

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
  const normalized = process.platform === "win32" ? resolve(stateDbPath).toLowerCase() : resolve(stateDbPath);
  const id = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(getConfigDir(), `codex-history-backup-${id}.json`);
}
const RESUMABLE_SOURCES = ["cli", "vscode"] as const;

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

export type CodexHistoryProvider = "openai" | "opencodex";

export type CodexHistoryFailureReason = "busy" | "permission";

export interface CodexHistorySyncResult {
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
  | { readonly kind: "unknown"; readonly present: boolean; readonly reason: "manifest-read" | "manifest-schema" | "manifest-foreign" };

let afterNoopPendingCountForTests: (() => void) | undefined;

/** Test seam: runs after the pending count and before stability validation. */
export function setAfterNoopPendingCountForTests(hook: (() => void) | undefined): void {
  afterNoopPendingCountForTests = hook;
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

function inspectBackupForNoop(path: string, stateDbPath: string): StrictBackupInspection {
  if (!existsSync(path)) return { kind: "known", present: false, entries: 0, fingerprint: "absent" };
  let parsed: unknown;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unknown", present: true, reason: "manifest-read" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unknown", present: true, reason: "manifest-schema" };
  }
  const manifest = parsed as Partial<BackupManifest>;
  if (manifest.version !== 1 || typeof manifest.stateDbPath !== "string") {
    return { kind: "unknown", present: true, reason: "manifest-schema" };
  }
  if (!samePath(manifest.stateDbPath, stateDbPath)) {
    return { kind: "unknown", present: true, reason: "manifest-foreign" };
  }
  if (!manifest.entries || typeof manifest.entries !== "object" || Array.isArray(manifest.entries)) {
    return { kind: "unknown", present: true, reason: "manifest-schema" };
  }
  for (const [id, value] of Object.entries(manifest.entries)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { kind: "unknown", present: true, reason: "manifest-schema" };
    }
    const entry = value as Partial<BackupEntry>;
    if (entry.id !== id
      || typeof entry.rolloutPath !== "string"
      || typeof entry.modelProvider !== "string"
      || typeof entry.source !== "string"
      || typeof entry.hasUserEvent !== "number") {
      return { kind: "unknown", present: true, reason: "manifest-schema" };
    }
  }
  return {
    kind: "known",
    present: true,
    entries: Object.keys(manifest.entries).length,
    fingerprint: createHash("sha256").update(raw).digest("hex"),
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
export function readLatestSessionMeta(path: string): ParsedSessionMeta | null {
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
 * True when a READONLY probe proves the openai-direction restore would be a no-op:
 * zero threads still tagged opencodex AND an empty backup manifest. Used to skip the
 * write-open entirely in the Design B steady state — on Windows the Codex app holds
 * `state_5.sqlite` (WAL, busy_timeout 5s), so an unnecessary write open can stall for
 * seconds and surface a false lock warning, while WAL always admits readers. A failed
 * probe (locked even for readers / schema drift) returns false so callers fall through
 * to the write attempt and keep today's behavior for genuinely unknown state.
 */
function openaiRestoreIsNoop(stateDbPath: string, backupPath: string): boolean {
  const pending = countPendingOpencodexHistory(stateDbPath, backupPath);
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
  const retried = withHistoryRetryResult(() => syncCodexHistoryProviderUnsafe(provider, stateDbPath, backupPath));
  return retried.ok ? retried.value : { rows: 0, files: 0, failed: true, failureReason: retried.reason };
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

export function restoreLegacyOpenaiHistory(stateDbPath = resolveCodexStateDbPath()): CodexHistorySyncResult {
  if (!existsSync(stateDbPath)) return { rows: 0, files: 0 };
  const retried = withHistoryRetryResult(() => {
    const db = openStateDb(stateDbPath);
    try {
      return ejectRemainingOpencodexHistory(db);
    } finally {
      db.close();
    }
  });
  return retried.ok ? retried.value : { rows: 0, files: 0, failed: true, failureReason: retried.reason };
}

/**
 * One-time Design-B migration: restore backed-up originals, then eject any remaining
 * opencodex-tagged threads to openai. Thin wrapper over the restore path with a
 * configurable retry budget — the daemon migration guardian uses `{ attempts: 1 }`
 * per tick so a locked DB never stalls the event loop beyond one sqlite busy wait.
 */
export function migrateHistoryToOpenai(
  stateDbPath = resolveCodexStateDbPath(),
  backupPath = historyBackupPathFor(stateDbPath),
  opts: { attempts?: number; delayMs?: number; sleepFn?: (ms: number) => void } = {},
): CodexHistorySyncResult {
  if (!existsSync(stateDbPath)) return { rows: 0, files: 0 };
  // Steady-state gate: this migration is Design-B-specific (inject + guardian callers),
  // and after the one-time migration every start would otherwise write-open the DB for
  // nothing. A missing DB with a leftover backup manifest does NOT satisfy the gate
  // (backupEntries > 0), so the guardian's fresh-reinstall re-count protection holds.
  if (openaiRestoreIsNoop(stateDbPath, backupPath)) return { rows: 0, files: 0 };
  const retried = withHistoryRetryResult(() => syncCodexHistoryProviderUnsafe("openai", stateDbPath, backupPath), opts);
  return retried.ok ? retried.value : { rows: 0, files: 0, failed: true, failureReason: retried.reason };
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
  if (!samePath(backupPath, historyBackupPathFor(stateDbPath))) {
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
    const pending = countPendingOpencodexHistory(stateDbPath, backupPath);
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
  /** Threads still tagged opencodex that the eject path WOULD move (mirrors its WHERE). */
  pendingRows: number;
  /** Entries still recorded in the backup manifest (restore targets). */
  backupEntries: number;
  /** Set when the DB could not be opened/read (locked); counts are then unknown, not zero. */
  failed?: true;
}

/**
 * Read-only migration progress probe for the guardian and `ocx doctor`. Opens sqlite
 * readonly with a SHORT busy timeout so a locked DB cannot stall a daemon tick. The
 * pending predicate mirrors ejectRemainingOpencodexHistory exactly — rows eject ignores
 * (empty first_user_message) are not counted, so 0 really means "migration done".
 */
export function countPendingOpencodexHistory(
  stateDbPath = resolveCodexStateDbPath(),
  backupPath = historyBackupPathFor(stateDbPath),
): PendingHistoryCount {
  let backupEntries = 0;
  try {
    const manifest = readBackup(backupPath, stateDbPath);
    backupEntries = Object.keys(manifest.entries).length;
  } catch { /* unreadable manifest counts as 0 — restore treats it the same way */ }

  if (!existsSync(stateDbPath)) return { pendingRows: 0, backupEntries };
  try {
    const db = new Database(stateDbPath, { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 100");
      const row = db.query<{ n: number }, []>(`
        SELECT count(*) AS n
        FROM threads
        WHERE model_provider = 'opencodex'
          AND trim(coalesce(first_user_message, '')) != ''
      `).get();
      return { pendingRows: row?.n ?? 0, backupEntries };
    } finally {
      db.close();
    }
  } catch (error) {
    if (isRecoverableHistoryError(error)) return { pendingRows: 0, backupEntries, failed: true };
    // Schema drift (e.g. a future codex renames the table) is a "cannot know" too, not a crash.
    return { pendingRows: 0, backupEntries, failed: true };
  }
}
