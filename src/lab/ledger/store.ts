import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { jcsStringify } from "../digest";
import { MAX_SERIALIZED_EVENT_BYTES } from "../constants";
import type { LabEvent, LedgerCorruption, ReplayResult } from "../events/types";
import { LabValidationError, validateLabEvent } from "../events/validate";
import { ensureLabDirs, labLedgerPath } from "../paths";

export interface LedgerStore {
  path: string;
  append(event: LabEvent): void;
  replay(): ReplayResult;
}

/** Durable append of one validated event as a single JSONL line + fsync. */
export function appendLabEvent(ledgerPath: string, event: LabEvent): void {
  const validated = validateLabEvent(event);
  mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });
  const line = `${jcsStringify(validated)}\n`;
  const bytes = new TextEncoder().encode(line);
  const fd = openSync(ledgerPath, "a", 0o600);
  try {
    let written = 0;
    while (written < bytes.byteLength) {
      const n = writeSync(fd, bytes, written, bytes.byteLength - written);
      if (n <= 0) {
        throw new LabValidationError("short_write", "ledger append made no progress");
      }
      written += n;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function processLine(
  line: string,
  lineNumber: number,
  lineHasTrailingNewline: boolean,
  events: LabEvent[],
  seenIds: Set<string>,
  corruptions: LedgerCorruption[],
): void {
  if (!lineHasTrailingNewline) {
    corruptions.push({
      kind: "partial_line",
      lineNumber,
      detail: "partial final JSONL line (missing trailing newline)",
    });
    return;
  }
  if (line.trim() === "") {
    corruptions.push({ kind: "malformed_line", lineNumber, detail: "empty line" });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    corruptions.push({ kind: "malformed_line", lineNumber, detail: "JSON parse failed" });
    return;
  }

  let event: LabEvent;
  try {
    event = validateLabEvent(parsed);
  } catch (err) {
    corruptions.push({
      kind: "invalid_event",
      lineNumber,
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (seenIds.has(event.eventId)) {
    corruptions.push({
      kind: "duplicate_event",
      lineNumber,
      eventId: event.eventId,
      detail: "duplicate eventId",
    });
    return;
  }
  seenIds.add(event.eventId);
  events.push(event);
}

function processBufferedLines(
  buf: Buffer,
  state: {
    lineNumber: number;
    totalLineCount: number;
    skippingOversizedLine: boolean;
    events: LabEvent[];
    seenIds: Set<string>;
    corruptions: LedgerCorruption[];
  },
): { carry: Buffer; skippingOversizedLine: boolean } {
  let start = 0;
  let skipping = state.skippingOversizedLine;

  while (start < buf.length) {
    const newlineIdx = buf.indexOf(0x0a, start);
    if (newlineIdx < 0) {
      const tail = buf.subarray(start);
      if (skipping) {
        return { carry: Buffer.alloc(0), skippingOversizedLine: true };
      }
      if (tail.length > MAX_SERIALIZED_EVENT_BYTES) {
        state.lineNumber += 1;
        state.totalLineCount += 1;
        state.corruptions.push({
          kind: "malformed_line",
          lineNumber: state.lineNumber,
          detail: `line exceeds ${MAX_SERIALIZED_EVENT_BYTES} bytes without newline`,
        });
        // Drop the oversized prefix immediately. Keeping it would defeat the
        // replay memory bound and count the same line again at EOF.
        return { carry: Buffer.alloc(0), skippingOversizedLine: true };
      }
      return { carry: tail, skippingOversizedLine: false };
    }

    const lineBytes = buf.subarray(start, newlineIdx);
    start = newlineIdx + 1;

    if (skipping) {
      skipping = false;
      continue;
    }

    state.lineNumber += 1;
    state.totalLineCount += 1;
    // Decode only complete JSONL lines. Keeping incomplete line bytes as Buffer
    // carry naturally preserves UTF-8 code points split across read chunks.
    processLine(lineBytes.toString("utf8"), state.lineNumber, true, state.events, state.seenIds, state.corruptions);
  }

  return { carry: Buffer.alloc(0), skippingOversizedLine: skipping };
}

/**
 * Replay the JSONL ledger using chunked reads (no whole-file string buffer).
 * Malformed or partial lines contribute no evidence and are reported as corruption.
 */
export function replayLabLedger(ledgerPath: string): ReplayResult {
  const corruptions: LedgerCorruption[] = [];
  const events: LabEvent[] = [];
  if (!existsSync(ledgerPath)) {
    return { events, corruptions, validLineCount: 0, totalLineCount: 0 };
  }
  const size = statSync(ledgerPath).size;
  if (size === 0) {
    return {
      events,
      corruptions: [{ kind: "empty_ledger", detail: "ledger file is empty" }],
      validLineCount: 0,
      totalLineCount: 0,
    };
  }

  const fd = openSync(ledgerPath, "r");
  const chunkSize = 64 * 1024;
  const chunk = Buffer.alloc(chunkSize);
  let carry: Buffer = Buffer.alloc(0);
  let lineNumber = 0;
  let totalLineCount = 0;
  const seenIds = new Set<string>();
  let offset = 0;
  let skippingOversizedLine = false;

  const state = {
    lineNumber,
    totalLineCount,
    skippingOversizedLine,
    events,
    seenIds,
    corruptions,
  };

  try {
    while (offset < size) {
      const toRead = Math.min(chunkSize, size - offset);
      const n = readSync(fd, chunk, 0, toRead, offset);
      if (n <= 0) break;
      offset += n;

      // `chunk` is reused by readSync, so any bytes retained beyond this
      // iteration must be detached from it before the next read.
      const combined = carry.length > 0
        ? Buffer.concat([carry, chunk.subarray(0, n)])
        : Buffer.from(chunk.subarray(0, n));
      const result = processBufferedLines(combined, state);
      carry = result.carry.length > 0 ? Buffer.from(result.carry) : Buffer.alloc(0);
      skippingOversizedLine = result.skippingOversizedLine;
      state.skippingOversizedLine = skippingOversizedLine;
      lineNumber = state.lineNumber;
      totalLineCount = state.totalLineCount;
    }

    if (carry.length > 0) {
      if (skippingOversizedLine) {
        lineNumber += 1;
        totalLineCount += 1;
        corruptions.push({
          kind: "malformed_line",
          lineNumber,
          detail: `oversized line exceeds ${MAX_SERIALIZED_EVENT_BYTES} bytes`,
        });
      } else if (carry.length > MAX_SERIALIZED_EVENT_BYTES) {
        lineNumber += 1;
        totalLineCount += 1;
        corruptions.push({
          kind: "malformed_line",
          lineNumber,
          detail: `partial line exceeds ${MAX_SERIALIZED_EVENT_BYTES} bytes`,
        });
      } else {
        lineNumber += 1;
        totalLineCount += 1;
        processLine(carry.toString("utf8"), lineNumber, false, events, seenIds, corruptions);
      }
    }
  } finally {
    closeSync(fd);
  }

  return {
    events,
    corruptions,
    validLineCount: events.length,
    totalLineCount,
  };
}

export function openLedgerStore(configDir?: string): LedgerStore {
  const paths = ensureLabDirs(configDir);
  return {
    path: paths.ledgerPath,
    append(event: LabEvent) {
      appendLabEvent(paths.ledgerPath, event);
    },
    replay() {
      return replayLabLedger(paths.ledgerPath);
    },
  };
}

export function defaultLedgerPath(configDir?: string): string {
  return labLedgerPath(configDir);
}
