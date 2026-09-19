/**
 * Usage ledger size-limit enforcement.
 *
 * When `usageLedgerMaxBytes` is configured, this module truncates `usage.jsonl`
 * after a write causes the file to exceed the limit. Truncation keeps only
 * the newest complete JSONL rows that fit within the budget, written to a
 * temporary file and atomically renamed over the original. The derived
 * `routing-history.sqlite` index is closed and deleted so it auto-rebuilds on next query.
 *
 * Design constraints (from PR #4042 lessons & CodeRabbit review):
 *  - Memory usage stays bounded: uses backward chunk scanning (max 64 KiB chunks)
 *    to find row boundaries, streaming/copying in chunks rather than allocating
 *    the entire maxBytes buffer in memory.
 *  - High/Low watermark hysteresis: truncates to 90% of maxBytes (retention headroom)
 *    to avoid rewriting the entire ledger on every append once the ceiling is reached.
 *  - Strict I/O robustness: uses readAllSync for all bounded reads to guarantee
 *    complete range population before advancing offsets, and writeAllSync to retry
 *    partial writes.
 *  - Complete row preservation: only complete JSONL rows are retained; partial/torn
 *    tails are discarded.
 *  - A valid single oversized row (larger than the limit) is preserved.
 *    If the newest row is oversized, earlier rows are discarded and the newest
 *    row is validated: retained if valid, discarded if confirmed corrupt.
 *  - Crash durability: fsyncSync on the temp descriptor before closing, and parent
 *    directory fsyncSync on POSIX after atomic rename.
 *  - SQLite lifecycle: calls closeRequestHistoryIndex before deleting SQLite files.
 *  - Invalidation: discards in-memory usage snapshot and resets index db handle.
 *  - Best-effort: failures are logged/swallowed so request paths never fail.
 *  - No scheduler or background worker: inline enforcement after append.
 */

import {
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  writeSync,
  chmodSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { renameAtomicFile } from "../lib/windows-atomic-replace";
import { closeRequestHistoryIndex } from "../routing/history/indexer";
import { discardRetainedUsageSnapshot, normalizePersistedUsageRow } from "./log";

/** Floor: retention limits below this are treated as unconfigured. */
export const MIN_USAGE_LEDGER_MAX_BYTES = 1024 * 1024; // 1 MiB

/** Default ceiling when enabled through the GUI (1 GiB). */
export const DEFAULT_USAGE_LEDGER_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB

/** Target headroom ratio: when truncating, trim to 90% of maxBytes to prevent rewrite on every append. */
const RETENTION_LOW_WATERMARK_RATIO = 0.9;

/** Bounded chunk size for backward scanning and copying (64 KiB). */
const SCAN_CHUNK_BYTES = 64 * 1024;

let truncationInProgress = false;

/**
 * Module-level configured limit. Set once from config at startup via
 * `setUsageLedgerMaxBytes()`. The default (`undefined`) means no limit.
 */
let configuredMaxBytes: number | undefined;

/**
 * Set the configured max bytes for usage ledger retention.
 * Called from the startup path after config is loaded.
 */
export function setUsageLedgerMaxBytes(maxBytes: number | undefined): void {
  configuredMaxBytes = (maxBytes !== undefined && maxBytes >= MIN_USAGE_LEDGER_MAX_BYTES)
    ? maxBytes
    : undefined;
}

/** Read the currently configured limit (test observability). */
export function getUsageLedgerMaxBytes(): number | undefined {
  return configuredMaxBytes;
}

/**
 * If a limit is configured and the file at `ledgerPath` exceeds it,
 * rewrite the file keeping only the newest complete rows that fit.
 *
 * Called synchronously after `appendUsageEntry`; must never throw into
 * the request path.
 */
export function enforceUsageLedgerSizeLimit(ledgerPath: string): void {
  if (configuredMaxBytes === undefined) return;
  if (truncationInProgress) return;

  let fd: number | undefined;
  try {
    fd = openSync(ledgerPath, "r");
    const size = Number(fstatSync(fd).size);
    if (size <= configuredMaxBytes) return;
    closeSync(fd);
    fd = undefined;

    truncationInProgress = true;
    try {
      truncateUsageLedger(ledgerPath, configuredMaxBytes);
    } finally {
      truncationInProgress = false;
    }
  } catch {
    // Best-effort: a failure here must not block the request that just
    // appended its usage row successfully.
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** Check if a line is a valid, parseable usage entry. */
function isValidUsageRow(line: string): boolean {
  try {
    return normalizePersistedUsageRow(JSON.parse(line)) !== undefined;
  } catch {
    return false;
  }
}

type RowValidation = "valid" | "invalid" | "unverifiable";

/** Read exact byte count from fd at position, looping until filled or EOF. Returns actual bytes read. */
function readAllSync(fd: number, buf: Buffer, length: number, position: number): number {
  let total = 0;
  while (total < length) {
    const r = readSync(fd, buf, total, length - total, position + total);
    if (r === 0) break;
    total += r;
  }
  return total;
}

/** Write all bytes from buffer to fd, retrying partial writes. */
function writeAllSync(fd: number, buf: Buffer, length: number): void {
  let written = 0;
  while (written < length) {
    const count = writeSync(fd, buf, written, length - written);
    if (count === 0) throw new Error("zero-byte write in ledger retention");
    written += count;
  }
}

/**
 * Validate a byte range in an open fd as a complete valid usage row without unbounded memory allocations.
 * Returns:
 * - "valid": definitively valid and parseable as a normalized usage row.
 * - "invalid": definitively malformed JSON or missing required fields.
 * - "unverifiable": I/O error or excessive size exceeding memory allocation budget.
 */
function validateRangeUsageRow(fd: number, start: number, end: number): RowValidation {
  const len = end - start;
  if (len <= 0) return "invalid";
  if (!Number.isSafeInteger(len)) return "unverifiable";

  // Check start byte to catch non-JSON data without allocations
  const peekBuf = Buffer.allocUnsafe(Math.min(len, 64));
  const peekRead = readAllSync(fd, peekBuf, peekBuf.length, start);
  if (peekRead === 0) return "unverifiable";
  const firstNonWs = peekBuf.subarray(0, peekRead).find(b => b !== 0x20 && b !== 0x09 && b !== 0x0d && b !== 0x0a);
  if (firstNonWs !== 0x7b) return "invalid"; // Must start with '{'

  // If reasonably sized (<= 64 MiB), allocate and parse completely
  const MAX_PARSE_ALLOCATION = 64 * 1024 * 1024;
  if (len > MAX_PARSE_ALLOCATION) {
    // For rows larger than 64 MiB, memory pressure on the request path would be severe.
    // Rather than classifying as corrupt and discarding, treat as unverifiable.
    return "unverifiable";
  }

  try {
    const buf = Buffer.allocUnsafe(len);
    const bytesRead = readAllSync(fd, buf, len, start);
    if (bytesRead !== len) return "unverifiable";
    const text = buf.toString("utf-8");
    return isValidUsageRow(text) ? "valid" : "invalid";
  } catch {
    return "unverifiable";
  }
}

/**
 * Read the ledger with bounded memory to find the newest complete JSONL rows
 * fitting within `maxBytes` (aiming for the low watermark), write them to a temp file,
 * and atomically replace.
 */
function truncateUsageLedger(ledgerPath: string, maxBytes: number): void {
  let inFd: number | undefined;
  let outFd: number | undefined;
  const tmpPath = join(dirname(ledgerPath), `.usage-retention-${process.pid}.tmp`);

  try {
    inFd = openSync(ledgerPath, "r");
    const fileSize = Number(fstatSync(inFd).size);
    if (fileSize <= maxBytes) return;

    // Target low watermark budget to leave headroom and avoid rewrite churn
    const targetBudget = Math.max(1, Math.floor(maxBytes * RETENTION_LOW_WATERMARK_RATIO));

    // Phase 1: Determine the valid retained range [retainedStart, retainedEnd)
    // First, check the end of the file. If it doesn't end with LF, find the last LF.
    let retainedEnd = fileSize;
    let needsTrailingLf = false;
    const tailCheckSize = Math.min(fileSize, SCAN_CHUNK_BYTES);
    const tailBuffer = Buffer.allocUnsafe(tailCheckSize);
    const tailRead = readAllSync(inFd, tailBuffer, tailCheckSize, fileSize - tailCheckSize);

    if (tailRead > 0 && tailBuffer[tailRead - 1] !== 0x0a) {
      // Missing trailing newline: crash tail or unterminated line.
      // Search backward for the last LF in the file.
      let foundLastLf = -1;
      let checkOffset = fileSize;

      while (checkOffset > 0 && foundLastLf === -1) {
        const chunkSize = Math.min(checkOffset, SCAN_CHUNK_BYTES);
        const buf = Buffer.allocUnsafe(chunkSize);
        const bytesRead = readAllSync(inFd, buf, chunkSize, checkOffset - chunkSize);
        if (bytesRead === 0) break;
        const lastIdx = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
        if (lastIdx >= 0) {
          foundLastLf = (checkOffset - chunkSize) + lastIdx + 1;
        } else {
          checkOffset -= chunkSize;
        }
      }

      if (foundLastLf === -1) {
        // No newline anywhere in the entire file.
        const res = validateRangeUsageRow(inFd, 0, fileSize);
        if (res === "valid" || res === "unverifiable") {
          return; // Valid or unverifiable oversized row: preserve original file intact
        }
        // Confirmed corrupt/invalid single line: discard by writing empty file
        retainedEnd = 0;
      } else {
        // An older LF-terminated row exists, but the file tail lacks a trailing newline.
        // Validate [foundLastLf, fileSize) to see if it is a complete valid JSON record.
        const tailValidation = validateRangeUsageRow(inFd, foundLastLf, fileSize);
        if (tailValidation === "valid") {
          retainedEnd = fileSize;
          needsTrailingLf = true; // Append LF to temporary file so subsequent appends do not merge
        } else if (tailValidation === "unverifiable") {
          return; // Cannot prove invalidity; leave ledger unchanged
        } else {
          retainedEnd = foundLastLf; // Discard partial/crash tail
        }
      }
    }

    // Now determine retainedStart so that (retainedEnd - retainedStart) <= targetBudget
    // and retainedStart sits right after an LF (complete row boundary).
    let retainedStart = 0;
    const targetLength = retainedEnd;

    if (targetLength > targetBudget) {
      const minStart = retainedEnd - targetBudget;
      // We scan forward from minStart to find the first LF,
      // so the retained region starts at that LF + 1.
      let scanOffset = minStart;
      let foundFirstLf = -1;

      while (scanOffset < retainedEnd && foundFirstLf === -1) {
        const chunkSize = Math.min(retainedEnd - scanOffset, SCAN_CHUNK_BYTES);
        const buf = Buffer.allocUnsafe(chunkSize);
        const bytesRead = readAllSync(inFd, buf, chunkSize, scanOffset);
        if (bytesRead === 0) break;
        const firstIdx = buf.subarray(0, bytesRead).indexOf(0x0a);
        if (firstIdx >= 0) {
          foundFirstLf = scanOffset + firstIdx + 1;
        } else {
          scanOffset += chunkSize;
        }
      }

      if (foundFirstLf === -1 || foundFirstLf >= retainedEnd) {
        // The newest complete row itself spans more than targetBudget (an oversized row).
        // Find the start of this newest row by scanning backward from retainedEnd - 1.
        let newestRowStart = 0;
        let backOffset = retainedEnd - 1; // skip trailing LF of newest row
        while (backOffset > 0) {
          const chunkSize = Math.min(backOffset, SCAN_CHUNK_BYTES);
          const buf = Buffer.allocUnsafe(chunkSize);
          const bytesRead = readAllSync(inFd, buf, chunkSize, backOffset - chunkSize);
          if (bytesRead === 0) break;
          const lfIdx = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
          if (lfIdx >= 0) {
            newestRowStart = (backOffset - chunkSize) + lfIdx + 1;
            break;
          }
          backOffset -= chunkSize;
        }

        // Validate the newest oversized row
        const newestValidation = validateRangeUsageRow(inFd, newestRowStart, retainedEnd);
        if (newestValidation === "valid") {
          if (newestRowStart === 0 && retainedEnd === fileSize) {
            return; // Sole line in file is a valid oversized row; preserve file
          }
          // The newest row is valid: discard older rows and retain this newest row
          retainedStart = newestRowStart;
        } else if (newestValidation === "unverifiable") {
          // Cannot prove invalidity (e.g. allocation failure or >64MB row).
          // Do not delete: leave the original file untouched.
          return;
        } else {
          // Confirmed corrupt/invalid newest row: discard it, keep earlier complete rows
          retainedEnd = newestRowStart;
          retainedStart = 0;
          if (retainedEnd > targetBudget) {
            // Re-apply budget ceiling to the earlier valid prefix
            retainedStart = Math.max(0, retainedEnd - targetBudget);
            let sOffset = retainedStart;
            let pFirstLf = -1;
            while (sOffset < retainedEnd && pFirstLf === -1) {
              const cSize = Math.min(retainedEnd - sOffset, SCAN_CHUNK_BYTES);
              const b = Buffer.allocUnsafe(cSize);
              const bRead = readAllSync(inFd, b, cSize, sOffset);
              if (bRead === 0) break;
              const idx = b.subarray(0, bRead).indexOf(0x0a);
              if (idx >= 0) pFirstLf = sOffset + idx + 1;
              else sOffset += cSize;
            }
            retainedStart = (pFirstLf !== -1 && pFirstLf < retainedEnd) ? pFirstLf : 0;
          }
        }
      } else {
        retainedStart = foundFirstLf;
      }
    }

    const retainedBytes = retainedEnd - retainedStart;

    // Phase 2: Copy [retainedStart, retainedEnd) to tmpPath in bounded chunks
    outFd = openSync(tmpPath, "w", 0o600);
    try { chmodSync(tmpPath, 0o600); } catch { /* best-effort */ }

    if (retainedBytes > 0) {
      let copyOffset = retainedStart;
      const copyBuffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);

      while (copyOffset < retainedEnd) {
        const toRead = Math.min(retainedEnd - copyOffset, SCAN_CHUNK_BYTES);
        const bytesRead = readAllSync(inFd, copyBuffer, toRead, copyOffset);
        if (bytesRead === 0) {
          // Premature EOF: source file shrank or was modified underneath us.
          // Abort operation to avoid writing partial content over original.
          throw new Error("premature EOF during ledger retention copy");
        }
        writeAllSync(outFd, copyBuffer, bytesRead);
        copyOffset += bytesRead;
      }
    }

    if (needsTrailingLf) {
      writeAllSync(outFd, Buffer.from("\n", "utf-8"), 1);
    }

    try { fsyncSync(outFd); } catch { /* best-effort */ }
    closeSync(outFd);
    outFd = undefined;
    closeSync(inFd);
    inFd = undefined;

    renameAtomicFile(tmpPath, ledgerPath, undefined, "usage-ledger-retention");

    // Sync parent directory on POSIX platforms for crash durability
    if (process.platform !== "win32") {
      try {
        const dirFd = openSync(dirname(ledgerPath), "r");
        try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      } catch { /* best-effort */ }
    }

    discardRetainedUsageSnapshot();
    closeRequestHistoryIndex();
    deleteRoutingHistoryIndex(ledgerPath);
  } catch {
    // Failure is tolerated; clean up temp file if present
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  } finally {
    if (inFd !== undefined) {
      try { closeSync(inFd); } catch { /* ignore */ }
    }
    if (outFd !== undefined) {
      try { closeSync(outFd); } catch { /* ignore */ }
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
}

/**
 * Best-effort deletion of the derived routing-history SQLite index.
 * The indexer auto-rebuilds from `usage.jsonl` on next query.
 */
function deleteRoutingHistoryIndex(ledgerPath: string): void {
  const dir = dirname(ledgerPath);
  for (const suffix of ["routing-history.sqlite", "routing-history.sqlite-wal", "routing-history.sqlite-shm"]) {
    const path = join(dir, suffix);
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch { /* best-effort */ }
  }
}

/** Test-only: expose truncation state for assertions. */
export function isTruncationInProgressForTests(): boolean {
  return truncationInProgress;
}

/**
 * Test-only: bypass the MIN_USAGE_LEDGER_MAX_BYTES floor.
 * Production code must use `setUsageLedgerMaxBytes()`.
 */
export function setUsageLedgerMaxBytesUnsafe(maxBytes: number | undefined): void {
  configuredMaxBytes = maxBytes;
}
