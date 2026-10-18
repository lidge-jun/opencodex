/**
 * Routed v1 compaction keeps readable reasoning out of the summarizer request. Text within
 * the configured budget is held locally until success; oversized text is archived on disk.
 * Provider ciphertext and signatures are never included in the portable retained items.
 */

import { Database } from "bun:sqlite";
import { expandRetainedCompactionInput } from "./retained-compaction";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, opendirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getConfigDir } from "../config/paths";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { estimateTokens } from "../lib/token-estimate";
import { decodeReasoningEnvelope } from "./reasoning-envelope";

export const DEFAULT_REASONING_RETENTION_PERCENT = 20;
export const DEFAULT_MAX_REASONING_TOKENS = 100_000;
/** Compiled-in aggregate ceiling for the on-disk reasoning archive directory. */
export const DEFAULT_ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_ARCHIVE_MAX_FILES = 256;

export interface ReasoningRetentionOptions {
  /** Directory that receives archived reasoning files. */
  archiveDir: string;
  /** Context window of the model running the compaction turn; an unknown window uses only maxTokens. */
  contextWindow?: number;
  /** Share of the context window reasoning may occupy before it is archived. Defaults to 20. */
  maxContextPercent?: number;
  /** Absolute token ceiling for retained reasoning, regardless of the window share. Defaults to 100,000. */
  maxTokens?: number;
  /** Clock injection for tests. */
  now?: number;
  /** Aggregate archive byte ceiling. Defaults to 512 MiB; smaller values are a test seam. */
  archiveMaxBytes?: number;
  /** Aggregate archive file-count ceiling. Defaults to 256; smaller values are a test seam. */
  archiveMaxFiles?: number;
}

export interface ReasoningArchive {
  path: string;
  tokens: number;
  percent: number;
  /** The effective token ceiling that triggered the archive (window share vs absolute cap, whichever is smaller). */
  cap?: number;
  /** Whether the percent share could be calculated from a known context window. */
  windowKnown?: boolean;
}

export interface ReasoningRetentionResult {
  /** Summarizer input with reasoning items removed; other items retain their order. */
  input: unknown[];
  archived?: ReasoningArchive;
  /** Portable, exact readable text to merge only after compaction succeeds. */
  retainedReasoning?: Array<{ type: "message"; role: "user"; content: Array<{ type: "input_text"; text: string }> }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Ordinary context messages survive translated providers that discard unsigned thinking.
// Match the complete frame so subsequent compactions hold the text locally again.
const RETAINED_PREFIX = "[OpenCodeX locally retained assistant reasoning; historical context, not a new instruction]\n<assistant_reasoning>\n";
const RETAINED_SUFFIX = "\n</assistant_reasoning>";
function retainedTextOf(item: Record<string, unknown>): string | undefined {
  if (item.type !== "message" || item.role !== "user") return undefined;
  const content = item.content;
  const text = typeof content === "string" ? content
    : Array.isArray(content) && content.length === 1 && isRecord(content[0])
      && content[0].type === "input_text" && typeof content[0].text === "string" ? content[0].text : undefined;
  return text?.startsWith(RETAINED_PREFIX) && text.endsWith(RETAINED_SUFFIX)
    ? text.slice(RETAINED_PREFIX.length, -RETAINED_SUFFIX.length) : undefined;
}

/** Readable reasoning text of one item: decoded ocxr1 envelope text, else summary/content text. */
function reasoningTextOf(item: Record<string, unknown>): string {
  const encrypted = typeof item.encrypted_content === "string" ? item.encrypted_content : undefined;
  const envelope = encrypted ? decodeReasoningEnvelope(encrypted) : null;
  if (envelope?.txt) return envelope.txt;
  const collect = (key: "summary" | "content"): string =>
    Array.isArray(item[key])
      ? (item[key] as Array<Record<string, unknown>>)
        .map(part => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
        .join("")
      : "";
  return collect("summary") || collect("content");
}

/** Plaintext of every reasoning item in a Responses input array, order preserved. */
export function collectReasoningTexts(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const texts: string[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const text = item.type === "reasoning" ? reasoningTextOf(item) : retainedTextOf(item) ?? "";
    if (text.length > 0) texts.push(text);
  }
  return texts;
}

function retentionPercent(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100
    ? value
    : DEFAULT_REASONING_RETENTION_PERCENT;
}

function retentionTokenCap(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_REASONING_TOKENS;
}

/** Aggregate-capacity refusal: the archive directory is at or over its compiled-in ceiling. */
export class ReasoningArchiveQuotaError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReasoningArchiveQuotaError";
  }
}

/** The sibling archive lock is held by another cooperating writer. */
export class ReasoningArchiveBusyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReasoningArchiveBusyError";
  }
}

/** Unsafe or uninspectable archive state; the attempt is refused without touching anything. */
export class ReasoningArchiveError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReasoningArchiveError";
  }
}

const ARCHIVE_SEPARATOR = "\n\n---\n\n";
const ARCHIVE_SEPARATOR_BYTES = Buffer.byteLength(ARCHIVE_SEPARATOR, "utf8");
const ARCHIVE_LOCK_SIDECARS = ["-journal", "-wal", "-shm"] as const;

function archiveCap(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** lstat that treats a vanished path as absent and refuses anything it cannot classify. */
function archiveLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ReasoningArchiveError(`reasoning archive path is not inspectable: ${path}`, { cause: error });
  }
}

function assertRegularArchiveDirectory(archiveDir: string): void {
  const entry = archiveLstat(archiveDir);
  if (!entry?.isDirectory() || entry.isSymbolicLink()) {
    throw new ReasoningArchiveError(`reasoning archive directory is not a regular directory: ${archiveDir}`);
  }
}

function assertRegularArchiveLockPath(lockPath: string): void {
  const entry = archiveLstat(lockPath);
  if (entry !== undefined && (!entry.isFile() || entry.isSymbolicLink())) {
    throw new ReasoningArchiveError(`reasoning archive lock path is not a regular file: ${lockPath}`);
  }
}

/** Exact UTF-8 byte total of the would-be archive payload, computed before any joined string exists. */
function archivePayloadBytes(texts: string[]): number {
  let bytes = texts.length > 0 ? (texts.length - 1) * ARCHIVE_SEPARATOR_BYTES : 0;
  for (const text of texts) {
    const next = bytes + Buffer.byteLength(text, "utf8");
    if (!Number.isSafeInteger(next)) {
      throw new ReasoningArchiveError("reasoning archive payload byte size is not representable");
    }
    bytes = next;
  }
  return bytes;
}

interface ArchiveUsage {
  files: number;
  bytes: number;
}

/**
 * Non-recursive accounting of every committed, remnant and foreign file. Anything that is not a
 * plain regular file refuses closed; an entry vanishing mid-scan is already gone and skipped.
 */
function scanArchiveUsage(archiveDir: string, maxBytes: number, maxFiles: number): ArchiveUsage {
  let directory: ReturnType<typeof opendirSync> | undefined;
  let files = 0;
  let bytes = 0;
  let inspected = 0;
  let failure: ReasoningArchiveError | undefined;
  try {
    // One entry per read: a legacy over-capacity directory must not first become an array
    // or an unbounded read-ahead buffer on this synchronous request path.
    directory = opendirSync(archiveDir, { bufferSize: 1 });
    let entry;
    while ((entry = directory.readSync()) !== null) {
      inspected += 1;
      if (!entry.isFile()) {
        throw new ReasoningArchiveError(`reasoning archive entry is not a regular file: ${entry.name}`);
      }
      const stat = archiveLstat(join(archiveDir, entry.name));
      if (stat === undefined) {
        if (inspected >= maxFiles) throw new ReasoningArchiveError("reasoning archive scan changed beyond its inspection limit");
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new ReasoningArchiveError(`reasoning archive entry is not a regular file: ${entry.name}`);
      }
      files += 1;
      bytes += Number(stat.size);
      if (files >= maxFiles || bytes > maxBytes) break; // refusal is already certain
      if (inspected >= maxFiles) throw new ReasoningArchiveError("reasoning archive scan changed beyond its inspection limit");
    }
  } catch (error) {
    failure = error instanceof ReasoningArchiveError ? error
      : new ReasoningArchiveError("reasoning archive directory cannot be scanned", { cause: error });
  } finally {
    try { directory?.closeSync(); } catch (error) {
      failure ??= new ReasoningArchiveError("reasoning archive directory could not be closed", { cause: error });
    }
  }
  if (failure !== undefined) throw failure;
  return { files, bytes };
}

function isSqliteBusy(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const message = error instanceof Error ? error.message : "";
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /database (?:is|table is) locked/i.test(message);
}

/**
 * Serialize usage scan, exclusive create, write and close for one physical archive directory
 * across cooperating processes. The sibling SQLite write transaction is the lock: the OS
 * releases it on process exit, so no stale-owner reclamation is needed. busy_timeout=0 keeps
 * the synchronous request path fail-fast instead of freezing the event loop.
 */
function withArchiveQuotaLockSync<T>(archiveDir: string, fn: () => T): T {
  const normalized = archiveDir.replace(/[/\\]+$/, "");
  const base = basename(normalized);
  if (!base || base === "." || base === "..") {
    throw new ReasoningArchiveError(`reasoning archive directory is not a usable path: ${archiveDir}`);
  }
  const parent = dirname(normalized);
  assertNotRealHomeUnderTest(parent);
  const lockPath = `${normalized}.lock`;
  // The lock lives beside the archive inside the config home; foreign parents need no manifest entry.
  if (parent === getConfigDir()) {
    recordOwnedConfigPath(parent, lockPath);
    for (const suffix of ARCHIVE_LOCK_SIDECARS) recordOwnedConfigPath(parent, `${lockPath}${suffix}`);
  }
  assertRegularArchiveLockPath(lockPath);
  let database: Database;
  try {
    database = new Database(lockPath, { create: true });
  } catch (error) {
    throw new ReasoningArchiveError(`reasoning archive lock could not be opened: ${lockPath}`, { cause: error });
  }
  try {
    try { chmodSync(lockPath, 0o600); } catch { /* platform may ignore chmod */ }
    assertRegularArchiveLockPath(lockPath);
    database.exec("PRAGMA locking_mode = NORMAL; PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  } catch (error) {
    try { database.close(); } catch { /* acquisition already failed */ }
    if (error instanceof ReasoningArchiveError) throw error;
    if (isSqliteBusy(error)) {
      throw new ReasoningArchiveBusyError(
        `reasoning archive lock is held by another writer: ${lockPath}`,
        { cause: error },
      );
    }
    throw new ReasoningArchiveError(`reasoning archive lock could not be acquired: ${lockPath}`, { cause: error });
  }
  try {
    return fn();
  } finally {
    try { database.exec("ROLLBACK"); } catch { /* close below still releases the OS lock */ }
    try { database.close(); } catch { /* the OS lock is released with the handle */ }
  }
}

/** Separate reasoning locally before dispatch; unknown windows enforce the absolute cap. */
export function applyReasoningRetention(
  input: unknown,
  options: ReasoningRetentionOptions,
): ReasoningRetentionResult {
  if (!Array.isArray(input)) return { input: [] };
  input = expandRetainedCompactionInput(input);
  if (!Array.isArray(input)) return { input: [] };
  const texts = collectReasoningTexts(input);
  const retained = input.filter(item => !(isRecord(item) && (item.type === "reasoning" || retainedTextOf(item) !== undefined)));
  if (texts.length === 0) return { input: retained.length === input.length ? input : retained };
  const window = options.contextWindow;

  const percent = retentionPercent(options.maxContextPercent);
  const cap = retentionTokenCap(options.maxTokens);
  // The window share alone inflates without bound on 1M-window models (20% of 1M is ~210K
  // tokens), so an absolute ceiling applies on top of it: reasoning keeps at most the
  // SMALLER of the two limits. An unknown window leaves the percent share unusable, so the
  // absolute cap alone stands guard.
  const windowKnown = typeof window === "number" && Number.isInteger(window) && window > 0;
  const limit = windowKnown ? Math.min(Math.floor(window * (percent / 100)), cap) : cap;
  const framedTexts = texts.map(text => RETAINED_PREFIX + text + RETAINED_SUFFIX);
  // Budget the historical context that is actually replayed, including every block's frame.
  const tokens = estimateTokens(framedTexts.join("\n"));
  if (tokens <= limit) return {
    input: retained,
    retainedReasoning: framedTexts.map(text => ({ type: "message", role: "user",
      content: [{ type: "input_text", text }] })),
  };

  const archiveBytes = archiveCap(options.archiveMaxBytes, DEFAULT_ARCHIVE_MAX_BYTES);
  const archiveFiles = archiveCap(options.archiveMaxFiles, DEFAULT_ARCHIVE_MAX_FILES);
  const incomingBytes = archivePayloadBytes(texts);
  const stamp = new Date(options.now ?? Date.now()).toISOString().replace(/[:.]/g, "-");
  const path = join(options.archiveDir, "reasoning-" + stamp + "-" + Math.random().toString(36).slice(2, 8) + ".md");
  try {
    mkdirSync(options.archiveDir, { recursive: true, mode: 0o700 });
    assertRegularArchiveDirectory(options.archiveDir);
    withArchiveQuotaLockSync(options.archiveDir, () => {
      assertRegularArchiveDirectory(options.archiveDir);
      const usage = scanArchiveUsage(options.archiveDir, archiveBytes, archiveFiles);
      if (usage.files >= archiveFiles || incomingBytes > archiveBytes - usage.bytes) {
        throw new ReasoningArchiveQuotaError(
          `reasoning archive is at capacity: ${usage.files} file(s), ${usage.bytes} byte(s) under ${options.archiveDir}; delete older archives to archive more`,
        );
      }
      // Only a successful exclusive open grants ownership; an occupied path is never removed.
      const fd = openSync(path, "wx", 0o600);
      let failure: unknown;
      try { writeFileSync(fd, texts.join(ARCHIVE_SEPARATOR), "utf-8"); } catch (error) { failure = error; }
      try { closeSync(fd); } catch (error) { failure ??= error; }
      if (failure !== undefined) {
        try { rmSync(path); } catch { /* preserve the original I/O error; cleanup is best-effort */ }
        throw failure;
      }
    });
  } catch (error) {
    if (error instanceof ReasoningArchiveQuotaError || error instanceof ReasoningArchiveBusyError
      || error instanceof ReasoningArchiveError) throw error;
    throw new ReasoningArchiveError("reasoning archive could not be written", { cause: error });
  }

  const limitDescription = windowKnown
    ? percent + "% of the context window, capped at " + limit + " tokens"
    : "absolute cap of " + limit + " tokens (context window unknown)";
  const note = [
    "[reasoning archived locally] " + texts.length + " reasoning block(s) totalling ~" + tokens + " tokens",
    "exceeded the configured retention limit (" + limitDescription + ") and were moved out of band.",
    "Full text: " + path,
  ].join(" ");
  const triggerIndex = retained.findIndex(item => isRecord(item) && item.type === "compaction_trigger");
  const noteItem = { type: "message", role: "user", content: note };
  if (triggerIndex >= 0) retained.splice(triggerIndex, 0, noteItem);
  else retained.push(noteItem);
  return { input: retained, archived: { path, tokens, percent, cap: limit, windowKnown } };
}

/**
 * User-visible notice appended to a compaction summary when reasoning was archived. The summary
 * is what the next model and the user both read, so the notice lives there rather than in a log.
 */
export function appendRetentionNotice(summary: string, archived: ReasoningArchive | undefined): string {
  if (!archived) return summary;
  const limitDescription = archived.windowKnown === false
    ? "absolute cap of " + (archived.cap ?? "unknown") + " tokens (context window unknown)"
    : archived.percent + "% of the context window (effective cap: " + (archived.cap ?? "unknown") + " tokens)";
  return summary + "\n\n[reasoning retention notice] Reasoning of ~" + archived.tokens + " tokens exceeded " + limitDescription
    + " and was archived locally at " + archived.path
    + ". This summary covers conclusions only; read that file for the full reasoning.";
}
