import {
  closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readSync, writeSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { redactUserPath } from "../../lib/redact";
import type { CatalogWriteAuditEvent } from "./write-audit-contract";

export const CODEX_CATALOG_AUDIT_FILE = "opencodex-catalog-audit.jsonl";
export const CATALOG_AUDIT_MAX_BYTES = 256 * 1024;
export const CATALOG_AUDIT_KEEP_RECORDS = 400;
export const CATALOG_AUDIT_MAX_EVENT_BYTES = 2 * 1024;
const MAX_HOME_CHARACTERS = 256;
const WRITERS = new Set([
  "convergence", "retained-sync", "cache-from-catalog", "cache-invalidate",
  "catalog-pull", "catalog-restore", "codex-restore", "sync-cache", "startup-cache",
]);

export function codexCatalogAuditPath(codexHome: string): string {
  return join(codexHome, CODEX_CATALOG_AUDIT_FILE);
}

function safeCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function auditLine(event: CatalogWriteAuditEvent): Buffer {
  const writer = WRITERS.has(event.writer) ? event.writer : "other";
  // Explicit projection: no argv, arbitrary event properties, model IDs or provider names.
  return Buffer.from(`${JSON.stringify({
    at: new Date().toISOString(), pid: process.pid, ppid: process.ppid,
    command: writer,
    opencodexHome: redactUserPath(event.opencodexHome).slice(0, MAX_HOME_CHARACTERS),
    target: event.target, outcome: event.outcome, reason: event.reason,
    intent: event.intent, writer,
    configSource: event.configSource,
    routedBefore: safeCount(event.routedBefore), routedAfter: safeCount(event.routedAfter),
  })}\n`);
}

function regularPrivateFile(stat: Stats): boolean {
  return stat.isFile() && stat.nlink === 1 && (process.platform === "win32"
    || (stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600));
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Read at most the tail budget plus one byte to locate a complete first record. */
function readTail(fd: number, size: number): Buffer {
  const start = Math.max(0, size - CATALOG_AUDIT_MAX_BYTES - 1);
  const bytes = Buffer.alloc(size - start);
  let length = 0;
  while (length < bytes.length) {
    const count = readSync(fd, bytes, length, bytes.length - length, start + length);
    if (count === 0) break;
    length += count;
  }
  if (length !== bytes.length) throw new Error("audit file changed during read");
  if (start === 0) return bytes;
  const boundary = bytes.indexOf(10);
  return boundary === -1 ? Buffer.alloc(0) : bytes.subarray(boundary + 1);
}

function completeRecords(bytes: Buffer): { records: Buffer[]; count: number; clean: boolean } {
  const records: Buffer[] = [];
  let start = 0;
  let clean = true;
  let count = 0;
  for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
    const line = bytes.subarray(start, end);
    try {
      const text = line.toString("utf8");
      if (!line.equals(Buffer.from(text))) throw new Error("invalid UTF-8");
      JSON.parse(text);
      records[count % CATALOG_AUDIT_KEEP_RECORDS] = bytes.subarray(start, end + 1);
      count++;
    } catch { clean = false; }
    start = end + 1;
  }
  const pivot = count > CATALOG_AUDIT_KEEP_RECORDS ? count % CATALOG_AUDIT_KEEP_RECORDS : 0;
  return { records: records.slice(pivot).concat(records.slice(0, pivot)), count,
    clean: clean && start === bytes.length };
}

function writeAll(fd: number, bytes: Buffer, position: number | null): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset,
      position === null ? null : position + offset);
    if (count === 0) throw new Error("audit write made no progress");
    offset += count;
  }
}

/**
 * Best-effort adapter. Caller MUST hold K, even for a refusal that has no permit.
 * Owners compact the verified descriptor; foreign callers can only append within both caps.
 * This diagnostic has no replay or authorization role. Process death may leave a partial line.
 */
export function appendCatalogWriteAudit(
  codexHome: string,
  event: CatalogWriteAuditEvent,
  options: { readonly create: boolean },
): "appended" | "created" | "skipped" {
  let fd: number | undefined;
  try {
    const line = auditLine(event);
    if (line.length > CATALOG_AUDIT_MAX_EVENT_BYTES) return "skipped";
    const path = codexCatalogAuditPath(codexHome);
    let before: Stats | undefined;
    try { before = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.create) return "skipped";
    }
    if (before && !regularPrivateFile(before)) return "skipped";
    // No mkdir, pathname truncation or chmod. O_EXCL prevents creation over a raced path.
    const flags = constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
      | (before ? (options.create ? 0 : constants.O_APPEND) : constants.O_CREAT | constants.O_EXCL);
    fd = openSync(path, flags, 0o600);
    const opened = fstatSync(fd);
    if (!regularPrivateFile(opened) || (before && !sameFile(before, opened))) return "skipped";
    if (!options.create && opened.size + line.length > CATALOG_AUDIT_MAX_BYTES) return "skipped";
    const tail = readTail(fd, opened.size);
    const parsed = completeRecords(tail);
    if (!sameFile(opened, fstatSync(fd)) || !sameFile(opened, lstatSync(path))) return "skipped";
    if (!options.create) {
      if (!parsed.clean || parsed.count + 1 > CATALOG_AUDIT_KEEP_RECORDS) return "skipped";
      writeAll(fd, line, null);
    } else if (opened.size <= CATALOG_AUDIT_MAX_BYTES - line.length
      && parsed.clean && parsed.count < CATALOG_AUDIT_KEEP_RECORDS) {
      writeAll(fd, line, opened.size);
    } else {
      const retained: Buffer[] = [line];
      let bytes = line.length;
      for (let index = parsed.records.length - 1; index >= 0 && retained.length < CATALOG_AUDIT_KEEP_RECORDS; index--) {
        const record = parsed.records[index]!;
        if (bytes + record.length > CATALOG_AUDIT_MAX_BYTES) break;
        retained.unshift(record);
        bytes += record.length;
      }
      const output = Buffer.concat(retained, bytes);
      writeAll(fd, output, 0);
      ftruncateSync(fd, output.length);
    }
    return before ? "appended" : "created";
  } catch {
    // Deliberately best-effort: an audit IO failure never changes the catalog result.
    return "skipped";
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* diagnostic only */ } }
  }
}
