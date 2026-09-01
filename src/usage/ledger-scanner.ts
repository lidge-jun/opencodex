import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
  currentUsageLogRevision,
  normalizePersistedUsageRow,
  usageLogIdentityKey,
  usageLogPath,
  usageLogRevisionKey,
  type PersistedUsageEntry,
  type UsageLogRevision,
} from "./log";

export const USAGE_LEDGER_READ_CHUNK_BYTES = 1024 * 1024;
// Normalized writer rows carry a <=16 KiB route trace and <=500-character captured
// upstream error, so 1 MiB leaves wide headroom even for an extreme multi-attempt row.
// Hand-edited rows can still exceed it; those are reported separately instead of making
// one unterminated line an unbounded allocation.
export const USAGE_LEDGER_MAX_LINE_BYTES = 1024 * 1024;
export const USAGE_LEDGER_BOUNDARY_DIGEST_BYTES = 64 * 1024;

export interface ScanUsageLedgerOptions {
  signal?: AbortSignal;
  onEntry: (entry: PersistedUsageEntry) => void;
  /** Absolute LF boundary returned by a previous scan. Defaults to byte zero. */
  startAtBytes?: number;
  /** Stable path/dev/ino/birthtime identity; required when startAtBytes is nonzero. */
  expectedIdentityKey?: string;
  /** Trailing digest at the previous boundary; required when startAtBytes is nonzero. */
  expectedProcessedThroughDigest?: string;
  /** Test seam for forcing byte boundaries; production always uses the 1 MiB default. */
  chunkBytes?: number;
}

export interface UsageLedgerScanResult {
  /** Revision whose EOF was captured when the scan opened the ledger. */
  revision: UsageLogRevision | null;
  parsedRows: number;
  /** LF-complete malformed/schema-invalid rows plus a non-empty bounded torn suffix. */
  invalidRows: number;
  /** Rows skipped after exceeding USAGE_LEDGER_MAX_LINE_BYTES. */
  oversizedRows: number;
  bytesRead: number;
  /** Absolute byte offset immediately after the last handled LF. */
  processedThroughBytes: number;
  /** SHA-256 over at most the last 64 KiB ending at processedThroughBytes. */
  processedThroughDigest: string;
}

export type UsageLedgerRebuildReason =
  | "identity_mismatch"
  | "shrink"
  | "boundary_mismatch"
  | "content_changed";

export class UsageLedgerRebuildRequiredError extends Error {
  readonly code = "usage_ledger_rebuild_required";

  constructor(readonly reason: UsageLedgerRebuildReason) {
    super(`usage ledger rebuild required: ${reason}`);
    this.name = "UsageLedgerRebuildRequiredError";
  }
}

function revisionFromStat(
  path: string,
  stat: ReturnType<typeof fstatSync>,
): UsageLogRevision {
  if (!stat.isFile()) throw new Error("usage log is not a regular file");
  return {
    path,
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    birthtimeMs: Number(stat.birthtimeMs),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("usage ledger scan aborted");
}

function isMissingFileError(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === "ENOENT";
}

function isJsonWhitespace(bytes: Buffer, length: number): boolean {
  for (let index = 0; index < length; index += 1) {
    const byte = bytes[index];
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) return false;
  }
  return true;
}

class RollingByteWindow {
  private readonly bytes: Buffer;
  private start = 0;
  private length = 0;

  constructor(private readonly capacity: number) {
    this.bytes = Buffer.allocUnsafe(capacity);
  }

  append(source: Buffer, from = 0, to = source.byteLength): void {
    const sourceLength = to - from;
    if (sourceLength <= 0) return;
    if (sourceLength >= this.capacity) {
      source.copy(this.bytes, 0, to - this.capacity, to);
      this.start = 0;
      this.length = this.capacity;
      return;
    }

    const overflow = Math.max(0, this.length + sourceLength - this.capacity);
    this.start = (this.start + overflow) % this.capacity;
    this.length -= overflow;
    const writeAt = (this.start + this.length) % this.capacity;
    const firstLength = Math.min(sourceLength, this.capacity - writeAt);
    source.copy(this.bytes, writeAt, from, from + firstLength);
    if (firstLength < sourceLength) {
      source.copy(this.bytes, 0, from + firstLength, to);
    }
    this.length += sourceLength;
  }

  appendByte(byte: number): void {
    if (this.length < this.capacity) {
      this.bytes[(this.start + this.length) % this.capacity] = byte;
      this.length += 1;
      return;
    }
    this.bytes[this.start] = byte;
    this.start = (this.start + 1) % this.capacity;
  }

  appendWindow(source: RollingByteWindow): void {
    if (source.length === 0) return;
    const firstLength = Math.min(source.length, source.capacity - source.start);
    this.append(source.bytes, source.start, source.start + firstLength);
    if (firstLength < source.length) {
      this.append(source.bytes, 0, source.length - firstLength);
    }
  }

  reset(): void {
    this.start = 0;
    this.length = 0;
  }

  digest(): string {
    const hash = createHash("sha256");
    if (this.length === 0) return hash.digest("hex");
    const firstLength = Math.min(this.length, this.capacity - this.start);
    hash.update(this.bytes.subarray(this.start, this.start + firstLength));
    if (firstLength < this.length) {
      hash.update(this.bytes.subarray(0, this.length - firstLength));
    }
    return hash.digest("hex");
  }
}

function rebuildRequired(reason: UsageLedgerRebuildReason): UsageLedgerRebuildRequiredError {
  return new UsageLedgerRebuildRequiredError(reason);
}

function captureRangeIntoWindow(
  fd: number,
  from: number,
  to: number,
  scratch: Buffer,
  window: RollingByteWindow,
  signal: AbortSignal | undefined,
): void {
  for (let position = from; position < to;) {
    throwIfAborted(signal);
    const requested = Math.min(scratch.byteLength, to - position);
    const read = readSync(fd, scratch, 0, requested, position);
    if (read === 0) throw rebuildRequired("shrink");
    window.append(scratch, 0, read);
    position += read;
  }
}

async function digestRangeCooperatively(
  fd: number,
  from: number,
  to: number,
  buffer: Buffer,
  signal: AbortSignal | undefined,
): Promise<string> {
  const hash = createHash("sha256");
  for (let position = from; position < to;) {
    throwIfAborted(signal);
    const requested = Math.min(buffer.byteLength, to - position);
    const read = readSync(fd, buffer, 0, requested, position);
    if (read === 0) throw rebuildRequired("shrink");
    hash.update(buffer.subarray(0, read));
    position += read;
    if (position < to) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return hash.digest("hex");
}

/**
 * Cooperatively scans a full ledger or validated append suffix with bounded memory.
 *
 * The opened EOF is the snapshot boundary: bytes appended after the initial fstat are
 * deliberately left for the next scan. Rows are framed as raw bytes before UTF-8 decoding,
 * so a multi-byte character may safely cross any read boundary. Only LF-terminated rows are
 * published; a torn final write is skipped rather than accepted prematurely.
 */
export async function scanUsageLedgerCooperatively(
  options: ScanUsageLedgerOptions,
): Promise<UsageLedgerScanResult> {
  const chunkBytes = options.chunkBytes ?? USAGE_LEDGER_READ_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > USAGE_LEDGER_READ_CHUNK_BYTES) {
    throw new RangeError(`usage ledger chunk bytes must be between 1 and ${USAGE_LEDGER_READ_CHUNK_BYTES}`);
  }
  const startAtBytes = options.startAtBytes ?? 0;
  if (!Number.isSafeInteger(startAtBytes) || startAtBytes < 0) {
    throw new RangeError("usage ledger start offset must be a non-negative safe integer");
  }
  if (startAtBytes > 0
    && (options.expectedIdentityKey === undefined
      || options.expectedProcessedThroughDigest === undefined)) {
    throw new TypeError(
      "usage ledger append scan requires expectedIdentityKey and expectedProcessedThroughDigest",
    );
  }
  throwIfAborted(options.signal);

  const path = usageLogPath();
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if (isMissingFileError(error)) {
      if (startAtBytes > 0
        || (options.expectedIdentityKey
          && options.expectedIdentityKey !== usageLogIdentityKey(null))) {
        throw rebuildRequired("identity_mismatch");
      }
      return {
        revision: null,
        parsedRows: 0,
        invalidRows: 0,
        oversizedRows: 0,
        bytesRead: 0,
        processedThroughBytes: 0,
        processedThroughDigest: createHash("sha256").digest("hex"),
      };
    }
    throw error;
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunk = Buffer.allocUnsafe(chunkBytes);
  const line = Buffer.allocUnsafe(USAGE_LEDGER_MAX_LINE_BYTES);
  let lineLength = 0;
  let droppingOversizedLine = false;
  let parsedRows = 0;
  let invalidRows = 0;
  let oversizedRows = 0;
  let bytesRead = 0;
  let bytesSinceYield = 0;
  let linesSinceYield = 0;
  let processedThroughBytes = startAtBytes;
  const capturedHash = createHash("sha256");
  const committedTail = new RollingByteWindow(USAGE_LEDGER_BOUNDARY_DIGEST_BYTES);
  const pendingTail = new RollingByteWindow(USAGE_LEDGER_BOUNDARY_DIGEST_BYTES);
  let pendingLineBytes = 0;

  try {
    const openedRevision = revisionFromStat(path, fstatSync(fd));
    const scanEnd = openedRevision.size;
    const openedIdentityKey = usageLogIdentityKey(openedRevision);
    if (options.expectedIdentityKey && options.expectedIdentityKey !== openedIdentityKey) {
      throw rebuildRequired("identity_mismatch");
    }
    if (scanEnd < startAtBytes) throw rebuildRequired("shrink");
    if (startAtBytes > 0) {
      const preceding = Buffer.allocUnsafe(1);
      const read = readSync(fd, preceding, 0, 1, startAtBytes - 1);
      if (read !== 1) throw rebuildRequired("shrink");
      if (preceding[0] !== 0x0a) throw rebuildRequired("boundary_mismatch");
    }
    if (options.expectedProcessedThroughDigest !== undefined) {
      captureRangeIntoWindow(
        fd,
        Math.max(0, startAtBytes - USAGE_LEDGER_BOUNDARY_DIGEST_BYTES),
        startAtBytes,
        line,
        committedTail,
        options.signal,
      );
      if (committedTail.digest() !== options.expectedProcessedThroughDigest) {
        throw rebuildRequired("content_changed");
      }
    }

    const publishLine = (): void => {
      if (lineLength === 0 || isJsonWhitespace(line, lineLength)) return;
      let entry: PersistedUsageEntry | undefined;
      try {
        const text = decoder.decode(line.subarray(0, lineLength));
        entry = normalizePersistedUsageRow(JSON.parse(text));
      } catch {
        invalidRows += 1;
        return;
      }
      if (!entry) {
        invalidRows += 1;
        return;
      }
      options.onEntry(entry);
      parsedRows += 1;
    };

    for (let position = startAtBytes; position < scanEnd;) {
      throwIfAborted(options.signal);
      const chunkStart = position;
      const requested = Math.min(chunk.byteLength, scanEnd - position);
      const read = readSync(fd, chunk, 0, requested, position);
      if (read === 0) throw rebuildRequired("shrink");
      position += read;
      bytesRead += read;
      bytesSinceYield += read;
      capturedHash.update(chunk.subarray(0, read));

      let cursor = 0;
      while (cursor < read) {
        const newline = chunk.indexOf(0x0a, cursor);
        const segmentEnd = newline >= 0 && newline < read ? newline : read;
        const segmentLength = segmentEnd - cursor;

        if (segmentLength > 0) {
          pendingTail.append(chunk, cursor, segmentEnd);
          pendingLineBytes = Math.min(
            USAGE_LEDGER_BOUNDARY_DIGEST_BYTES,
            pendingLineBytes + segmentLength,
          );
        }

        if (!droppingOversizedLine) {
          if (lineLength + segmentLength > USAGE_LEDGER_MAX_LINE_BYTES) {
            oversizedRows += 1;
            droppingOversizedLine = true;
            lineLength = 0;
          } else if (segmentLength > 0) {
            chunk.copy(line, lineLength, cursor, segmentEnd);
            lineLength += segmentLength;
          }
        }

        if (newline < 0 || newline >= read) break;
        linesSinceYield += 1;
        processedThroughBytes = chunkStart + newline + 1;
        if (pendingLineBytes + 1 >= USAGE_LEDGER_BOUNDARY_DIGEST_BYTES) {
          committedTail.reset();
        }
        committedTail.appendWindow(pendingTail);
        committedTail.appendByte(0x0a);
        pendingTail.reset();
        pendingLineBytes = 0;
        if (droppingOversizedLine) {
          droppingOversizedLine = false;
        } else {
          publishLine();
        }
        lineLength = 0;
        cursor = newline + 1;
      }

      if (position < scanEnd
        && (bytesSinceYield >= USAGE_LEDGER_READ_CHUNK_BYTES || linesSinceYield >= 1_000)) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        bytesSinceYield = 0;
        linesSinceYield = 0;
      }
    }

    // A non-empty suffix without LF is not a committed JSONL row, even when it happens
    // to contain valid JSON. Count it as invalid and leave it out of the aggregate.
    if (!droppingOversizedLine && lineLength > 0 && !isJsonWhitespace(line, lineLength)) {
      invalidRows += 1;
    }

    throwIfAborted(options.signal);
    const endingRevision = revisionFromStat(path, fstatSync(fd));
    if (usageLogIdentityKey(endingRevision) !== openedIdentityKey) {
      throw rebuildRequired("identity_mismatch");
    }
    if (endingRevision.size < scanEnd) throw rebuildRequired("shrink");
    const pathRevision = currentUsageLogRevision();
    if (!pathRevision || usageLogIdentityKey(pathRevision) !== openedIdentityKey) {
      throw rebuildRequired("identity_mismatch");
    }
    if (pathRevision.size < scanEnd) throw rebuildRequired("shrink");

    // A pure append changes size/mtime/ctime but leaves the captured prefix intact and
    // is safe to ignore until the next scan. Re-read only that prefix when a mutation
    // was observed, so a same-inode rewrite (including rewrite + growth) cannot publish
    // a mixture of old and new rows after a cooperative yield.
    const mutationObserved = usageLogRevisionKey(endingRevision) !== usageLogRevisionKey(openedRevision)
      || usageLogRevisionKey(pathRevision) !== usageLogRevisionKey(openedRevision);
    if (mutationObserved) {
      const capturedDigest = capturedHash.digest("hex");
      const verifiedDigest = await digestRangeCooperatively(
        fd,
        startAtBytes,
        scanEnd,
        line,
        options.signal,
      );
      const verifiedFdRevision = revisionFromStat(path, fstatSync(fd));
      const verifiedPathRevision = currentUsageLogRevision();
      if (capturedDigest !== verifiedDigest) throw rebuildRequired("content_changed");
      if (!verifiedPathRevision
        || usageLogIdentityKey(verifiedFdRevision) !== openedIdentityKey
        || usageLogIdentityKey(verifiedPathRevision) !== openedIdentityKey) {
        throw rebuildRequired("identity_mismatch");
      }
      if (verifiedFdRevision.size < scanEnd || verifiedPathRevision.size < scanEnd) {
        throw rebuildRequired("shrink");
      }
    }

    throwIfAborted(options.signal);
    const processedThroughDigest = committedTail.digest();

    return {
      revision: openedRevision,
      parsedRows,
      invalidRows,
      oversizedRows,
      bytesRead,
      processedThroughBytes,
      processedThroughDigest,
    };
  } finally {
    closeSync(fd);
  }
}
