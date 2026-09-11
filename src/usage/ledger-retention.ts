import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";

export const DEFAULT_USAGE_LEDGER_MAX_BYTES = 1024 * 1024 * 1024;
export const MIN_USAGE_LEDGER_MAX_BYTES = 1024 * 1024;
const SCAN_CHUNK_BYTES = 1024 * 1024;

/** Fully normalized policy used by the mutation path. */
export interface UsageLedgerRetention {
  enabled: boolean;
  maxBytes: number;
}

export interface UsageLedgerRevision {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface PreparedUsageLedgerCompaction {
  changed: true;
  path: string;
  tempPath: string;
  beforeBytes: number;
  afterBytes: number;
  droppedBytes: number;
  sourceRevision: UsageLedgerRevision;
}

export interface SkippedUsageLedgerCompaction {
  changed: false;
  path: string;
  beforeBytes: number;
  afterBytes: number;
  droppedBytes: 0;
  reason: "missing" | "within_limit";
}

export type UsageLedgerCompactionPreparation =
  | PreparedUsageLedgerCompaction
  | SkippedUsageLedgerCompaction;

/**
 * Normalize the destructive retention policy fail-closed.
 *
 * Unknown keys disable the feature rather than being silently stripped: a typo
 * such as `maxByets` must never turn an intended large limit into the default.
 * Invalid/unsafe byte values likewise disable the feature. A valid maxBytes is
 * retained while disabled so toggling the feature off does not erase user choice.
 */
export function normalizeUsageLedgerRetention(raw: unknown): UsageLedgerRetention {
  const disabled = { enabled: false, maxBytes: DEFAULT_USAGE_LEDGER_MAX_BYTES } as const;
  if (raw === undefined || raw === null) return disabled;
  if (typeof raw !== "object" || Array.isArray(raw)) return disabled;

  const row = raw as Record<string, unknown>;
  const allowed = new Set(["enabled", "maxBytes"]);
  if (Object.keys(row).some(key => !allowed.has(key))) return disabled;
  if (row.enabled !== undefined && typeof row.enabled !== "boolean") return disabled;

  const maxBytes = row.maxBytes ?? DEFAULT_USAGE_LEDGER_MAX_BYTES;
  if (
    typeof maxBytes !== "number"
    || !Number.isSafeInteger(maxBytes)
    || maxBytes < MIN_USAGE_LEDGER_MAX_BYTES
  ) {
    return disabled;
  }
  return { enabled: row.enabled === true, maxBytes };
}

/** Snapshot the identity fields used to prove the source did not change. */
export function usageLedgerRevisionFromStat(stat: {
  dev: number | bigint;
  ino: number | bigint;
  size: number | bigint;
  mtimeMs: number;
  ctimeMs: number;
}): UsageLedgerRevision {
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
  };
}

/** Exact revision comparison used immediately before the atomic replace. */
export function usageLedgerRevisionMatches(
  left: UsageLedgerRevision,
  right: UsageLedgerRevision,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

/** Find the final complete-line delimiter before `endExclusive`. */
function findLastNewline(fd: number, endExclusive: number): number {
  const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
  let end = endExclusive;
  while (end > 0) {
    const start = Math.max(0, end - buffer.length);
    const length = end - start;
    const read = readSync(fd, buffer, 0, length, start);
    for (let index = read - 1; index >= 0; index -= 1) {
      if (buffer[index] === 0x0a) return start + index;
    }
    end = start;
  }
  return -1;
}

/** Find the next complete-line delimiter at or after `startInclusive`. */
function findFirstNewline(fd: number, startInclusive: number, endExclusive: number): number {
  const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
  let start = startInclusive;
  while (start < endExclusive) {
    const length = Math.min(buffer.length, endExclusive - start);
    const read = readSync(fd, buffer, 0, length, start);
    if (read <= 0) return -1;
    for (let index = 0; index < read; index += 1) {
      if (buffer[index] === 0x0a) return start + index;
    }
    start += read;
  }
  return -1;
}

/** Copy an exact byte range while tolerating short reads/writes. */
function copyRange(sourceFd: number, targetFd: number, start: number, endExclusive: number): number {
  const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
  let offset = start;
  let written = 0;
  while (offset < endExclusive) {
    const wanted = Math.min(buffer.length, endExclusive - offset);
    const read = readSync(sourceFd, buffer, 0, wanted, offset);
    if (read <= 0) break;
    let cursor = 0;
    while (cursor < read) {
      cursor += writeSync(targetFd, buffer, cursor, read - cursor);
    }
    offset += read;
    written += read;
  }
  return written;
}

/**
 * Build a compacted candidate without mutating the live ledger.
 *
 * The candidate contains only complete JSONL rows. The start scan has no fixed
 * probe ceiling, so a single row larger than the copy chunk cannot leak a
 * partial prefix. The backward scan drops an unterminated crash tail. If one
 * complete row itself exceeds maxBytes it is dropped, preserving the hard cap.
 *
 * `candidatePath` lets the parent process own the temporary path before a Worker
 * starts. That ownership is required so timeout/shutdown can remove a candidate
 * even when the Worker produced it but its completion message was never claimed.
 */
export function prepareUsageLedgerCompaction(
  path: string,
  maxBytes: number,
  candidatePath?: string,
): UsageLedgerCompactionPreparation {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_USAGE_LEDGER_MAX_BYTES) {
    throw new RangeError(`maxBytes must be a safe integer >= ${MIN_USAGE_LEDGER_MAX_BYTES}`);
  }
  if (!existsSync(path)) {
    return { changed: false, path, beforeBytes: 0, afterBytes: 0, droppedBytes: 0, reason: "missing" };
  }

  const sourceFd = openSync(path, "r");
  let tempPath: string | null = null;
  try {
    const sourceStat = fstatSync(sourceFd);
    const sourceRevision = usageLedgerRevisionFromStat(sourceStat);
    const beforeBytes = sourceRevision.size;
    if (beforeBytes <= maxBytes) {
      return {
        changed: false,
        path,
        beforeBytes,
        afterBytes: beforeBytes,
        droppedBytes: 0,
        reason: "within_limit",
      };
    }

    const lastNewline = findLastNewline(sourceFd, beforeBytes);
    const completeEnd = lastNewline < 0 ? 0 : lastNewline + 1;
    const desiredStart = Math.max(0, completeEnd - maxBytes);
    let retainedStart = 0;
    if (desiredStart > 0) {
      const previousByte = Buffer.allocUnsafe(1);
      const startsAtRowBoundary =
        readSync(sourceFd, previousByte, 0, 1, desiredStart - 1) === 1
        && previousByte[0] === 0x0a;
      if (startsAtRowBoundary) {
        retainedStart = desiredStart;
      } else {
        const newline = findFirstNewline(sourceFd, desiredStart, completeEnd);
        retainedStart = newline < 0 ? completeEnd : newline + 1;
      }
    }

    tempPath = candidatePath ?? `${path}.retention-${process.pid}-${crypto.randomUUID()}.tmp`;
    const targetFd = openSync(tempPath, "wx", 0o600);
    let afterBytes = 0;
    try {
      afterBytes = copyRange(sourceFd, targetFd, retainedStart, completeEnd);
      fsyncSync(targetFd);
    } finally {
      closeSync(targetFd);
    }
    try { chmodSync(tempPath, 0o600); } catch { /* best-effort on platforms that ignore chmod */ }

    const result: PreparedUsageLedgerCompaction = {
      changed: true,
      path,
      tempPath,
      beforeBytes,
      afterBytes,
      droppedBytes: beforeBytes - afterBytes,
      sourceRevision,
    };
    tempPath = null;
    return result;
  } finally {
    closeSync(sourceFd);
    if (tempPath) {
      try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    }
  }
}
