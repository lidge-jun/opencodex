/**
 * Read-only view of the bounded Remote Link diagnostics file that `diagnostics.ts` writes:
 * `<configDir>/link/diagnostics.jsonl` and its one rotated backup, `diagnostics.jsonl.1`.
 *
 * Nothing here creates, hardens, truncates or rewrites anything. A file is read only when it is a
 * regular file reached without following a symlink (the link directory included), at most its
 * newest 256 KiB, and every line goes back through the writer's own allowlist
 * (`linkDiagnosticMetadata`) plus the two fields the sink adds, `timestamp` and `suppressed`.
 * The file is never trusted: a line that does not survive the allowlist is counted in `skipped`
 * and never echoed, so a tampered file cannot inject text into a terminal or the dashboard.
 */
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { linkDiagnosticMetadata, type LinkDiagnosticRecord } from "./diagnostics";
import { linkDir } from "./paths";

export const LINK_DIAGNOSTICS_SCHEMA = "ocx.link.diagnostics/1";
export const LINK_DIAGNOSTICS_DEFAULT_LIMIT = 200;
export const LINK_DIAGNOSTICS_MAX_LIMIT = 1000;
/** The writer's per-file cap; a larger file has been tampered with or predates the cap. */
const MAX_FILE_BYTES = 256 * 1024;
/** A written record is well under 1 KiB; anything this long was not written by the sink. */
const MAX_LINE_BYTES = 4 * 1024;
/** The latest time a JavaScript Date can hold; a larger timestamp would throw when shown. */
const MAX_DATE_MS = 8_640_000_000_000_000;
const FILE_NAMES = ["diagnostics.jsonl.1", "diagnostics.jsonl"] as const;

export type LinkDiagnosticEntry = LinkDiagnosticRecord & { timestamp?: number; suppressed?: number };
export type LinkDiagnosticsFileName = typeof FILE_NAMES[number];
/** `refused`: a symlink, a non-regular file, or a file under a symlinked link directory. */
export type LinkDiagnosticsFileState = "absent" | "read" | "refused" | "unreadable";
export interface LinkDiagnosticsFileReport { name: LinkDiagnosticsFileName; state: LinkDiagnosticsFileState; truncated: boolean }
export interface LinkDiagnosticsReadResult {
  /** Backup first, then the current file, each in line order; the newest `limit` matches. */
  records: LinkDiagnosticEntry[];
  /** Records that matched `since` before `limit` was applied. */
  matched: number;
  /** Lines that were malformed, overlong, cut by the size bound or outside the allowlist. */
  skipped: number;
  files: LinkDiagnosticsFileReport[];
}

/** The current diagnostics file, for messages; the reader derives both paths from the link directory. */
export function linkDiagnosticsPath(configDir?: string): string {
  return join(linkDir(configDir), "diagnostics.jsonl");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One parsed line through the writer's allowlist, plus the sink's `timestamp` and `suppressed`. */
export function sanitizeLinkDiagnosticEntry(value: unknown): LinkDiagnosticEntry | null {
  if (!isPlainRecord(value)) return null;
  const base = linkDiagnosticMetadata(value as unknown as LinkDiagnosticRecord);
  if (!base) return null;
  const entry: LinkDiagnosticEntry = base;
  const { timestamp, suppressed } = value;
  if (typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= MAX_DATE_MS) entry.timestamp = timestamp;
  if (typeof suppressed === "number" && Number.isSafeInteger(suppressed) && suppressed >= 1) entry.suppressed = suppressed;
  return entry;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function sameObject(named: BigIntStats, opened: BigIntStats): boolean {
  return opened.isFile() && named.dev === opened.dev && named.ino === opened.ino;
}

type FileRead = { state: LinkDiagnosticsFileState; text: string; truncated: boolean };

async function readBounded(path: string): Promise<FileRead> {
  const none = (state: LinkDiagnosticsFileState): FileRead => ({ state, text: "", truncated: false });
  let named: BigIntStats;
  try { named = await lstat(path, { bigint: true }); }
  catch (error) { return none(errorCode(error) === "ENOENT" ? "absent" : "unreadable"); }
  if (named.isSymbolicLink() || !named.isFile()) return none("refused");
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // Read-only, no-follow and non-blocking: a symlink or FIFO swapped in after lstat fails here
    // or is caught by the identity check below, and nothing is ever created.
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = errorCode(error);
    return none(code === "ENOENT" ? "absent" : code === "ELOOP" ? "refused" : "unreadable");
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameObject(named, opened)) return none("refused");
    const size = Number(opened.size);
    const length = Math.min(size, MAX_FILE_BYTES);
    const position = size - length;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { state: "read", text: buffer.subarray(0, offset).toString("utf8"), truncated: position > 0 };
  } catch {
    return none("unreadable");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The link directory must be a real directory; a symlinked one is not followed. */
async function linkDirectoryState(dir: string): Promise<"present" | "absent" | "refused" | "unreadable"> {
  try {
    const info = await lstat(dir);
    return info.isDirectory() && !info.isSymbolicLink() ? "present" : "refused";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "absent" : "unreadable";
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return LINK_DIAGNOSTICS_DEFAULT_LIMIT;
  return Math.min(LINK_DIAGNOSTICS_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * Read both diagnostics files without changing anything. `since` keeps records whose timestamp is
 * at or after it (records without one are left out); `limit` keeps the newest matches and is
 * clamped to 1..LINK_DIAGNOSTICS_MAX_LIMIT.
 */
export async function readLinkDiagnostics(
  { configDir, limit, since }: { configDir?: string; limit?: number; since?: number } = {},
): Promise<LinkDiagnosticsReadResult> {
  const dir = linkDir(configDir);
  const directory = await linkDirectoryState(dir);
  const files: LinkDiagnosticsFileReport[] = [];
  const records: LinkDiagnosticEntry[] = [];
  let skipped = 0;
  for (const name of FILE_NAMES) {
    const read = directory === "present" ? await readBounded(join(dir, name))
      : { state: directory, text: "", truncated: false } as FileRead;
    files.push({ name, state: read.state, truncated: read.truncated });
    if (read.state !== "read") continue;
    const lines = read.text.split("\n");
    // A size-bounded read starts mid-line; that fragment is not a record.
    if (read.truncated && lines.length > 0) {
      lines.shift();
      skipped += 1;
    }
    for (const raw of lines) {
      if (raw.trim() === "") continue;
      if (Buffer.byteLength(raw) > MAX_LINE_BYTES) { skipped += 1; continue; }
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { skipped += 1; continue; }
      const entry = sanitizeLinkDiagnosticEntry(parsed);
      if (!entry) { skipped += 1; continue; }
      if (since !== undefined && (entry.timestamp === undefined || entry.timestamp < since)) continue;
      records.push(entry);
    }
  }
  const kept = clampLimit(limit);
  return { records: records.slice(-kept), matched: records.length, skipped, files };
}
