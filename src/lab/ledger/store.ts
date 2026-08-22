import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
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

export interface LedgerMutationContext {
  replay(): ReplayResult;
  append(event: LabEvent): void;
  appendIfAbsent(event: LabEvent): boolean;
}

const LEDGER_LOCK_STALE_MS = 60_000;
const LEDGER_LOCK_WAIT_MS = 5_000;

interface LedgerLockMeta {
  pid: number;
  createdAt: number;
  token: string;
}

/** Block synchronously for the given duration (ledger lock retry only). */
function sleepSyncMs(ms: number): void {
  Bun.sleepSync(ms);
}

/** Read pid, createdAt, and token metadata from a ledger lock file, if well-formed. */
function readLedgerLockMeta(lockPath: string): LedgerLockMeta | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as LedgerLockMeta;
    if (
      typeof parsed.pid === "number"
      && typeof parsed.createdAt === "number"
      && typeof parsed.token === "string"
      && parsed.token.length > 0
    ) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Return true when the lock holder process is still running. */
function isLockHolderAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return false;
  }
}

/** Return true when a ledger lock file has dead metadata and can be recovered. */
function isLedgerLockStale(lockPath: string): boolean {
  const meta = readLedgerLockMeta(lockPath);
  if (!meta) {
    try {
      return Date.now() - statSync(lockPath).mtimeMs > LEDGER_LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
  return !isLockHolderAlive(meta.pid);
}

/** Write lock ownership metadata to a newly created exclusive lock file. */
function writeLedgerLockMeta(fd: number, token: string): void {
  const metadataBytes = Buffer.from(JSON.stringify({
    pid: process.pid,
    createdAt: Date.now(),
    token,
  }), "utf8");
  let written = 0;
  while (written < metadataBytes.byteLength) {
    const n = writeSync(fd, metadataBytes, written, metadataBytes.byteLength - written);
    if (n <= 0) {
      throw new LabValidationError("short_write", "ledger lock metadata write incomplete");
    }
    written += n;
  }
}

/** Discard a lock whose exclusive creator failed before publishing ownership metadata. */
function discardUninitialisedLedgerLock(lockPath: string, lockFd: number): void {
  try {
    closeSync(lockFd);
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(lockPath);
  } catch {
    /* best-effort */
  }
}

/** Release a lock file only when the token still matches the path owner. */
function releaseLedgerLock(lockPath: string, lockFd: number, token: string): void {
  try {
    closeSync(lockFd);
  } catch {
    /* ignore */
  }
  try {
    const meta = readLedgerLockMeta(lockPath);
    if (meta?.token === token) unlinkSync(lockPath);
  } catch {
    /* best-effort */
  }
}

/**
 * Recover one stale lock while holding a separate recovery mutex.
 *
 * The recovery mutex prevents two waiters from both observing the same stale
 * owner and then unlinking each other's replacement lock. If a process dies
 * while holding the recovery mutex, acquisition fails closed instead of
 * guessing ownership of that mutex.
 */
function recoverStaleLedgerLock(lockPath: string): boolean {
  const recoveryPath = `${lockPath}.recovery`;
  const token = randomBytes(16).toString("hex");
  let recoveryFd: number;
  try {
    recoveryFd = openSync(
      recoveryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }

  try {
    writeLedgerLockMeta(recoveryFd, token);
  } catch (error) {
    discardUninitialisedLedgerLock(recoveryPath, recoveryFd);
    throw error;
  }

  try {
    // Re-check after taking the recovery mutex. Another waiter may already
    // have recovered the old lock and installed a live replacement.
    if (!existsSync(lockPath) || !isLedgerLockStale(lockPath)) return false;
    unlinkSync(lockPath);
    return true;
  } finally {
    releaseLedgerLock(recoveryPath, recoveryFd, token);
  }
}

/** Create a ledger lock file exclusively, recovering stale locks when needed. */
function tryAcquireLedgerLock(lockPath: string, deadline: number): { fd: number; token: string } {
  while (Date.now() < deadline) {
    const token = randomBytes(16).toString("hex");
    let fd: number;
    try {
      fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    } catch (error) {
      if (existsSync(lockPath) && isLedgerLockStale(lockPath)) {
        try {
          if (recoverStaleLedgerLock(lockPath)) continue;
        } catch (recoveryError) {
          if (Date.now() >= deadline) throw recoveryError;
        }
      }
      if (Date.now() >= deadline) throw error;
      sleepSyncMs(10);
      continue;
    }
    try {
      writeLedgerLockMeta(fd, token);
    } catch (error) {
      discardUninitialisedLedgerLock(lockPath, fd);
      throw error;
    }
    return { fd, token };
  }
  throw new Error("ledger lock acquisition timed out");
}

/** Run a ledger mutation while holding the compatibility ledger lock file. */
function withLedgerLock<T>(ledgerPath: string, fn: () => T): T {
  const lockPath = `${ledgerPath}.lock`;
  mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LEDGER_LOCK_WAIT_MS;
  const { fd, token } = tryAcquireLedgerLock(lockPath, deadline);
  try {
    return fn();
  } finally {
    releaseLedgerLock(lockPath, fd, token);
  }
}

/** Durable append of one already-validated event as a single JSONL line + fsync. */
function appendValidatedLabEvent(ledgerPath: string, event: LabEvent): void {
  mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });
  const line = `${jcsStringify(event)}\n`;
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

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  ) && typeof (value as { then?: unknown }).then === "function";
}

/**
 * Serialize a ledger read-modify-write transaction with all ordinary appends.
 * The callback is intentionally synchronous. Mutation methods become invalid
 * as soon as the callback returns, so an accidental async continuation cannot
 * write after the lock has been released.
 */
export function withLedgerMutation<T>(
  ledgerPath: string,
  fn: (mutation: LedgerMutationContext) => T,
): T {
  return withLedgerLock(ledgerPath, () => {
    let active = true;
    const requireActive = () => {
      if (!active) {
        throw new LabValidationError(
          "inactive_ledger_mutation",
          "ledger mutation context used after its lock was released",
        );
      }
    };
    const replay = () => {
      requireActive();
      return replayLabLedger(ledgerPath);
    };
    const append = (event: LabEvent) => {
      requireActive();
      appendValidatedLabEvent(ledgerPath, validateLabEvent(event));
    };
    const appendIfAbsent = (event: LabEvent): boolean => {
      requireActive();
      const validated = validateLabEvent(event);
      if (replay().events.some((row) => row.eventId === validated.eventId)) return false;
      appendValidatedLabEvent(ledgerPath, validated);
      return true;
    };

    try {
      const result = fn({ replay, append, appendIfAbsent });
      if (isThenable(result)) {
        throw new LabValidationError(
          "async_ledger_mutation",
          "ledger mutation callback must be synchronous",
        );
      }
      return result;
    } finally {
      active = false;
    }
  });
}

/** Durable append of one validated event as a single JSONL line + fsync. */
export function appendLabEvent(ledgerPath: string, event: LabEvent): void {
  withLedgerMutation(ledgerPath, (mutation) => {
    mutation.append(event);
  });
}

/**
 * Append only when eventId is absent. Uses the same mutation lock as every
 * other ledger writer so the presence check and append are one transaction.
 */
export function appendLabEventIfAbsent(ledgerPath: string, event: LabEvent): boolean {
  return withLedgerMutation(ledgerPath, (mutation) => mutation.appendIfAbsent(event));
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