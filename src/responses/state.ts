import { chmodSync, existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFileAsync, getConfigDir, resolveWriteTarget } from "../config";
import { enforceAppOwnedMemoryBudget, type RetainedStoreSnapshot } from "../lib/app-owned-memory";
import type { OcxProviderContinuationState } from "../types";
import {
  deleteResponseSpill,
  noteStubSwapForTest,
  readResponseSpill,
  recoverOrphanedResponseSpills,
  responseSpillDirectory,
  responseSpillPayloadCap,
  type ResponseSpillRef,
  writeResponseSpillDurably,
} from "./spill-store";

const MAX_STORED_RESPONSES = 1_000;
const RESPONSE_TTL_MS = 60 * 60 * 1_000;
const SNAPSHOT_DEBOUNCE_MS = 2_000;
/** In-memory high-water byte cap across all entries. Forced store:false retention (kiro/cursor
 * continuation chains) stores the full expanded input each turn — ~quadratic bytes per chain —
 * so a count cap alone cannot bound memory. Oldest-first eviction applies past this mark. */
export const MAX_STORED_RESPONSE_BYTES = 64 * 1024 * 1024;
/** Legacy snapshot selection only. Spill demotion is governed solely by the RAM cap above. */
const SNAPSHOT_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_TOTAL_MAX_BYTES = 24 * 1024 * 1024;
/** Refuse-to-parse ceiling for an existing snapshot file (above the 24 MiB write
 * bound, so anything we wrote ourselves always loads; guards against externally
 * planted or pre-cap unbounded files being parsed whole). */
const SNAPSHOT_FILE_MAX_BYTES = 32 * 1024 * 1024;
const STALE_TEMP_GRACE_MS = 15 * 60 * 1_000;
const STALE_TEMP_MAX_ENTRIES = 4_096;
const STALE_TEMP_MAX_CLEANUPS = 512;
/** Absorbs `os.uptime()` granularity only. It is deliberately NOT the safety margin:
 *  the unconditional 15-minute grace above is (see the boot floor in the scan loop). */
const BOOT_FLOOR_SKEW_MS = 60 * 1_000;
/** Per-tick budget for the periodic reclaim. Smaller than the startup budget because the
 *  periodic pass runs synchronously on the serving process's event loop every 60 s. */
const PERIODIC_TEMP_MAX_ENTRIES = 512;
const PERIODIC_TEMP_MAX_CLEANUPS = 64;
/** Wall-clock ceiling for one periodic scan. An entry cap bounds syscalls, not time: on a
 *  network-mounted config dir each `lstat` can cost 10-20 ms, which would stall in-flight
 *  streams. Reclaim is idempotent, so a truncated tick simply resumes on the next one. */
const PERIODIC_TEMP_SCAN_DEADLINE_MS = 25;
const RESPONSE_STATE_TEMP_NAME = /^responses-state\.json\.ocx\.(\d+)\.(\d+)\.tmp$/;
const MAX_SNAPSHOT_REWRITE_ATTEMPTS = 4;

interface ResidentResponseState {
  kind: "resident";
  createdAt: number;
  clientThreadId?: string;
  items: unknown[];
  /** Index in `items` where provider output begins; see clientCarriedPrefixLength. */
  providerOutputStart?: number;
  providers?: OcxProviderContinuationState;
  sizeBytes: number;
}

interface SpilledResponseState {
  kind: "spill";
  createdAt: number;
  clientThreadId?: string;
  /** Mirrors the spilled payload boundary so a spilled entry keeps its anchor. */
  providerOutputStart?: number;
  providers?: OcxProviderContinuationState;
  spill: ResponseSpillRef;
  sizeBytes: number;
}

interface SpillFailedResponseState {
  kind: "spill-failed";
  createdAt: number;
  sizeBytes: number;
}

type StoredResponseState = ResidentResponseState | SpilledResponseState | SpillFailedResponseState;
type ResidentInput = Omit<ResidentResponseState, "kind" | "sizeBytes">;

export type PreviousResponseReplayFailure = {
  code: "previous_response_not_found";
  reason: "spill_missing" | "spill_corrupt" | "spill_failed" | "spill_too_large";
};

const states = new Map<string, StoredResponseState>();
const replayScopeMismatches = new WeakSet<object>();
let storedResponseBytes = 0;
let residentResponseBytes = 0;
let oldestResidentId: string | undefined;
let oldestResidentAt: number | null = null;
let byteCapOverride: number | null = null;
let stateRevision = 0;
const spillCounters = { writes: 0, writeFailures: 0, readFailures: 0 };
/**
 * Admission-boundary observability (test-visible). directSpills: oversized
 * candidates routed straight to durable spill without a resident stay or
 * unrelated demotion. oversizedDrops: candidates above the single-spill
 * payload ceiling, tombstoned instead of retained. snapshotOversizedRefusals:
 * snapshot files refused before parse.
 */
const admissionCounters = { directSpills: 0, oversizedDrops: 0, snapshotOversizedRefusals: 0 };
let replayScopeMismatchDrops = 0;

/** Test-only: admission-boundary counters (proves the new paths fire). */
export function responseAdmissionCountersForTests(): Readonly<typeof admissionCounters> {
  return admissionCounters;
}
// Superseded spill generations awaiting a durable snapshot before unlink
// (review C1-1: unlinking at swap time races a crash against the debounced
// snapshot — the reloaded OLD stub would point at a deleted file).
const pendingSpillUnlinks: ResponseSpillRef[] = [];
// The queue itself must stay bounded (review C2-2: repeated replacements with
// a persistently failing snapshot write would otherwise grow it without
// limit). Beyond the cap the OLDEST superseded generation is unlinked
// immediately: the accepted worst case is that a crash inside that window
// reloads a stub whose file is gone, which fails replay with the explicit
// structured 400 — bounded-loss, never silent corruption or unbounded disk.
const PENDING_SPILL_UNLINKS_MAX = 128;

function byteCap(): number {
  return byteCapOverride ?? MAX_STORED_RESPONSE_BYTES;
}

/** Test-only: lower/restore the in-memory byte cap (null restores the default). */
export function setResponseStateByteCapForTests(bytes: number | null): void {
  byteCapOverride = bytes;
}

/** Test-only: current in-memory byte accounting (proves evictions release their bytes). */
export function getStoredResponseBytesForTests(): number {
  return storedResponseBytes;
}

function serializedBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized, "utf8");
  } catch {
    return null;
  }
}

function measureResidentEntry(id: string, entry: ResidentInput): ResidentResponseState | null {
  const sizeBytes = serializedBytes({
    responseId: id,
    createdAt: entry.createdAt,
    ...(entry.clientThreadId ? { clientThreadId: entry.clientThreadId } : {}),
    items: entry.items,
    ...(entry.providerOutputStart !== undefined ? { providerOutputStart: entry.providerOutputStart } : {}),
    ...(entry.providers ? { providers: entry.providers } : {}),
  });
  return sizeBytes === null ? null : { kind: "resident", ...entry, sizeBytes };
}

function recomputeOldestResident(): void {
  oldestResidentId = undefined;
  oldestResidentAt = null;
  for (const [id, state] of states) {
    if (state.kind !== "resident") continue;
    if (oldestResidentAt !== null && state.createdAt >= oldestResidentAt) continue;
    oldestResidentId = id;
    oldestResidentAt = state.createdAt;
  }
}

function replaceMapEntry(id: string, next: StoredResponseState, expected?: StoredResponseState): boolean {
  const existing = states.get(id);
  if (expected && existing !== expected) return false;
  storedResponseBytes -= existing?.sizeBytes ?? 0;
  storedResponseBytes += next.sizeBytes;
  if (existing?.kind === "resident") {
    residentResponseBytes -= existing.sizeBytes;
  }
  if (next.kind === "resident") {
    residentResponseBytes += next.sizeBytes;
  }
  if (storedResponseBytes < 0) storedResponseBytes = 0;
  if (residentResponseBytes < 0) residentResponseBytes = 0;
  if (existing) states.delete(id);
  states.set(id, next);
  if (oldestResidentId === id) {
    recomputeOldestResident();
  } else if (next.kind === "resident" && (oldestResidentAt === null || next.createdAt < oldestResidentAt)) {
    oldestResidentId = id;
    oldestResidentAt = next.createdAt;
  }
  stateRevision += 1;
  return true;
}

function stubSize(id: string, entry: Omit<SpilledResponseState, "sizeBytes">): number {
  return serializedBytes({ responseId: id, ...entry }) ?? 0;
}

function tombstone(id: string, createdAt: number): SpillFailedResponseState {
  const base = { kind: "spill-failed" as const, createdAt };
  return { ...base, sizeBytes: serializedBytes({ responseId: id, ...base }) ?? 0 };
}

function deleteOwnedSpills(entry: StoredResponseState): void {
  if (entry.kind === "spill") deleteResponseSpill(entry.spill);
}

/** The ONLY deletion point: TTL, count, byte, and explicit deletes all route here. */
function deleteEntry(id: string, options: { deleteSpill?: boolean } = {}): void {
  const existing = states.get(id);
  if (!existing) return;
  storedResponseBytes -= existing.sizeBytes;
  if (existing.kind === "resident") {
    residentResponseBytes -= existing.sizeBytes;
  }
  if (storedResponseBytes < 0) storedResponseBytes = 0;
  if (residentResponseBytes < 0) residentResponseBytes = 0;
  states.delete(id);
  if (oldestResidentId === id) recomputeOldestResident();
  stateRevision += 1;
  if (options.deleteSpill !== false) deleteOwnedSpills(existing);
}

function replaceWithSpillFailure(
  id: string,
  expected?: StoredResponseState,
  options: { deferSpillUnlink?: boolean } = {},
): void {
  const existing = states.get(id);
  if (expected && existing !== expected) return;
  const failed = tombstone(id, expected?.createdAt ?? existing?.createdAt ?? now());
  if (replaceMapEntry(id, failed, expected)) {
    if (existing) {
      if (options.deferSpillUnlink && existing.kind === "spill") {
        // Crash consistency (same rule as replaceSpillEntryAtomically): the old
        // durable snapshot still references this generation until the tombstone
        // itself is durable — queue the unlink for the next stable persist.
        pendingSpillUnlinks.push(existing.spill);
        while (pendingSpillUnlinks.length > PENDING_SPILL_UNLINKS_MAX) {
          deleteResponseSpill(pendingSpillUnlinks.shift()!);
        }
      } else {
        deleteOwnedSpills(existing);
      }
    }
  }
}

function swapResidentForSpill(id: string, expected: ResidentResponseState, ref: ResponseSpillRef): boolean {
  const base: Omit<SpilledResponseState, "sizeBytes"> = {
    kind: "spill",
    createdAt: expected.createdAt,
    ...(expected.clientThreadId ? { clientThreadId: expected.clientThreadId } : {}),
    ...(expected.providers ? { providers: expected.providers } : {}),
    spill: ref,
  };
  const next: SpilledResponseState = { ...base, sizeBytes: stubSize(id, base) };
  if (!replaceMapEntry(id, next, expected)) {
    deleteResponseSpill(ref);
    return false;
  }
  noteStubSwapForTest();
  return true;
}

function replaceSpillEntryAtomically(
  id: string,
  expected: SpilledResponseState,
  candidate: ResidentResponseState,
): void {
  try {
    const ref = writeResponseSpillDurably(id, {
      createdAt: candidate.createdAt,
      ...(candidate.clientThreadId ? { clientThreadId: candidate.clientThreadId } : {}),
      items: candidate.items,
      ...(candidate.providerOutputStart !== undefined ? { providerOutputStart: candidate.providerOutputStart } : {}),
      ...(candidate.providers ? { providers: candidate.providers } : {}),
    });
    const base: Omit<SpilledResponseState, "sizeBytes"> = {
      kind: "spill",
      createdAt: candidate.createdAt,
      ...(candidate.clientThreadId ? { clientThreadId: candidate.clientThreadId } : {}),
      ...(candidate.providerOutputStart !== undefined ? { providerOutputStart: candidate.providerOutputStart } : {}),
      ...(candidate.providers ? { providers: candidate.providers } : {}),
      spill: ref,
    };
    const next: SpilledResponseState = { ...base, sizeBytes: stubSize(id, base) };
    if (!replaceMapEntry(id, next, expected)) {
      deleteResponseSpill(ref);
      return;
    }
    spillCounters.writes += 1;
    noteStubSwapForTest();
    // The old generation is NOT unlinked here (review C1-1): the new stub is
    // only durable once the debounced snapshot flushes — a crash before that
    // reloads the OLD stub, which must still find its file. Queue the unlink;
    // persistNow() drains the queue only after the snapshot write succeeds.
    pendingSpillUnlinks.push(expected.spill);
    while (pendingSpillUnlinks.length > PENDING_SPILL_UNLINKS_MAX) {
      deleteResponseSpill(pendingSpillUnlinks.shift()!);
    }
  } catch {
    spillCounters.writeFailures += 1;
    // deferSpillUnlink: the durable snapshot may still reference the old
    // generation; deleting it now would strand the old stub after a crash.
    replaceWithSpillFailure(id, expected, { deferSpillUnlink: true });
  }
}

function setResidentEntry(id: string, entry: ResidentInput): void {
  const expected = states.get(id);
  const candidate = measureResidentEntry(id, entry);
  if (!candidate) {
    replaceWithSpillFailure(id, expected);
    // A tombstone is tiny but still resident state: the hard-cap invariant
    // must hold on EVERY mutation path (review C2-1 — with a test cap below
    // tombstone size, skipping the prune leaves the store over cap).
    pruneResponses();
    return;
  }
  if (candidate.sizeBytes > byteCap()) {
    admitOversizedCandidate(id, candidate, expected);
    pruneResponses();
    return;
  }
  if (expected?.kind === "spill") {
    replaceSpillEntryAtomically(id, expected, candidate);
    pruneResponses();
    return;
  }
  if (!replaceMapEntry(id, candidate, expected)) return;
  pruneResponses();
}

/**
 * Admission boundary for candidates that can never fit as resident (larger
 * than the whole resident-map cap). Writes them DIRECTLY to durable spill and
 * installs only the stub — the oversized candidate never becomes resident and
 * no unrelated resident is demoted to make room for it. Candidates above the
 * single-spill payload ceiling are tombstoned instead: retaining a spill the
 * replay ceiling would refuse to read is write-only waste.
 */
function admitOversizedCandidate(
  id: string,
  candidate: ResidentResponseState,
  expected?: StoredResponseState,
): void {
  if (candidate.sizeBytes > responseSpillPayloadCap()) {
    admissionCounters.oversizedDrops += 1;
    replaceWithSpillFailure(id, expected, { deferSpillUnlink: true });
    return;
  }
  try {
    const ref = writeResponseSpillDurably(id, {
      createdAt: candidate.createdAt,
      ...(candidate.clientThreadId ? { clientThreadId: candidate.clientThreadId } : {}),
      items: candidate.items,
      ...(candidate.providerOutputStart !== undefined ? { providerOutputStart: candidate.providerOutputStart } : {}),
      ...(candidate.providers ? { providers: candidate.providers } : {}),
    });
    // Enforce the ceiling against the REAL envelope: the spill payload adds
    // the {version, responseId, ...} wrapper, so a candidate within the
    // wrapper's size of the cap would otherwise be retained unreadably.
    if (ref.payloadBytes > responseSpillPayloadCap()) {
      deleteResponseSpill(ref);
      admissionCounters.oversizedDrops += 1;
      replaceWithSpillFailure(id, expected, { deferSpillUnlink: true });
      return;
    }
    const base: Omit<SpilledResponseState, "sizeBytes"> = {
      kind: "spill",
      createdAt: candidate.createdAt,
      ...(candidate.clientThreadId ? { clientThreadId: candidate.clientThreadId } : {}),
      ...(candidate.providers ? { providers: candidate.providers } : {}),
      spill: ref,
    };
    const next: SpilledResponseState = { ...base, sizeBytes: stubSize(id, base) };
    if (!replaceMapEntry(id, next, expected)) {
      deleteResponseSpill(ref);
      return;
    }
    spillCounters.writes += 1;
    admissionCounters.directSpills += 1;
    noteStubSwapForTest();
    if (expected?.kind === "spill") {
      // Same deferred-unlink rule as replaceSpillEntryAtomically: the new stub
      // is durable only after the debounced snapshot, so the old generation
      // stays until a stable persist drains the queue.
      pendingSpillUnlinks.push(expected.spill);
      while (pendingSpillUnlinks.length > PENDING_SPILL_UNLINKS_MAX) {
        deleteResponseSpill(pendingSpillUnlinks.shift()!);
      }
    }
  } catch {
    spillCounters.writeFailures += 1;
    replaceWithSpillFailure(id, expected, { deferSpillUnlink: true });
  }
}

// Replay provenance must stay proxy-private: a WeakMap distinguishes replayed history from the
// newly appended input suffix without adding an unknown field that native passthrough could send
// upstream. The parser uses this boundary to acknowledge historical compaction markers exactly
// once. It records the boundary whether the proxy prepended the history or the client already
// carried it — the boundary is the same either way, and only its provenance differs.
const replayedInputPrefixLengths = new WeakMap<object, number>();
const replayFailures = new WeakMap<object, PreviousResponseReplayFailure>();
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersistPath: string | null = null;
/** Single-flight gate: overlapping response-state writes serialize (#612). */
let persistGate: Promise<void> = Promise.resolve();
let persistAttemptHookForTests: (() => void) | null = null;

function now(): number {
  return Date.now();
}

function snapshotPath(): string {
  return join(getConfigDir(), "responses-state.json");
}

interface LegacySnapshotState {
  createdAt?: unknown;
  clientThreadId?: unknown;
  items?: unknown;
  providers?: OcxProviderContinuationState;
  conversationId?: unknown;
  cursorCheckpointUsable?: unknown;
}

function isSpillRef(value: unknown): value is ResponseSpillRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as ResponseSpillRef;
  return ref.version === 1
    && typeof ref.fileName === "string"
    && /^[0-9a-f]{64}$/.test(ref.digest)
    && Number.isSafeInteger(ref.payloadBytes)
    && ref.payloadBytes >= 0;
}

function loadSnapshotEntry(id: string, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const rec = value as LegacySnapshotState & { kind?: unknown; spill?: unknown };
  if (typeof rec.createdAt !== "number" || !Number.isFinite(rec.createdAt)) return;
  const clientThreadId = typeof rec.clientThreadId === "string" && rec.clientThreadId.trim().length > 0
    ? rec.clientThreadId.trim()
    : undefined;
  // A malformed boundary degrades to "never skip" rather than to a bad index: an untrusted
  // snapshot must not be able to authorize dropping conversation history.
  const anchorFor = (itemCount: number): number | undefined => {
    const raw = (rec as { providerOutputStart?: unknown }).providerOutputStart;
    return Number.isSafeInteger(raw) && (raw as number) >= 0 && (raw as number) <= itemCount
      ? raw as number
      : undefined;
  };
  if (rec.kind === "spill") {
    if (!isSpillRef(rec.spill)) return;
    const base: Omit<SpilledResponseState, "sizeBytes"> = {
      kind: "spill",
      createdAt: rec.createdAt,
      ...(clientThreadId ? { clientThreadId } : {}),
      // Item count is unknown until materialization, so accept any non-negative integer
      // here; the spill payload validator re-checks it against the real array.
      ...(anchorFor(Number.MAX_SAFE_INTEGER) !== undefined ? { providerOutputStart: anchorFor(Number.MAX_SAFE_INTEGER) } : {}),
      ...(rec.providers ? { providers: rec.providers } : {}),
      spill: rec.spill,
    };
    replaceMapEntry(id, { ...base, sizeBytes: stubSize(id, base) });
    return;
  }
  if (rec.kind === "spill-failed") {
    replaceMapEntry(id, tombstone(id, rec.createdAt));
    return;
  }
  if (rec.kind !== undefined && rec.kind !== "resident") return;
  if (!Array.isArray(rec.items)) return;
  const providers = rec.providers ?? (typeof rec.conversationId === "string"
    ? {
        cursor: {
          conversationId: rec.conversationId,
          ...(typeof rec.cursorCheckpointUsable === "boolean"
            ? { checkpointUsable: rec.cursorCheckpointUsable }
            : {}),
        },
      }
    : undefined);
  const resident = measureResidentEntry(id, {
    createdAt: rec.createdAt,
    ...(clientThreadId ? { clientThreadId } : {}),
    items: rec.items,
    ...(anchorFor(rec.items.length) !== undefined ? { providerOutputStart: anchorFor(rec.items.length) } : {}),
    ...(providers ? { providers } : {}),
  });
  if (!resident) {
    replaceMapEntry(id, tombstone(id, rec.createdAt));
    return;
  }
  // Same admission boundary as live writes: an oversized snapshot row goes
  // straight to spill (or tombstone above the payload ceiling) instead of
  // entering the resident map and demoting unrelated rows on the first prune.
  if (resident.sizeBytes > byteCap()) {
    admitOversizedCandidate(id, resident, undefined);
    return;
  }
  replaceMapEntry(id, resident);
}

export interface ResponseStateTempRecoveryResult {
  matched: number;
  removed: number;
  failed: number;
  bytesRemoved: number;
  /** Entries that passed EVERY gate and would be reclaimed. In a dry run nothing is
   *  unlinked, so this is the only honest count to show an operator: `matched` is
   *  incremented before the file-type, age, boot-floor, and liveness gates. */
  eligible: number;
  /** Total size of the `eligible` entries. */
  eligibleBytes: number;
  /** The scan stopped on a budget (entry cap, cleanup cap, or deadline) rather than reaching
   *  the end of the directory, so the counts below describe a prefix of the backlog and not
   *  the backlog. `eligible > removed + failed` cannot express this: outside a dry run every
   *  eligible entry is unlinked or failed on the same iteration, so the two are always equal
   *  and a comparison between them is dead code. */
  truncated: boolean;
}

interface ResponseStateTempRecoveryIO {
  now: () => number;
  /** Approximate epoch ms of the current boot; see the boot floor in the scan loop. */
  bootTime: () => number;
  list: (dir: string) => Iterable<string>;
  inspect: (path: string) => { isFile: boolean; mtimeMs: number; size: number };
  isProcessAlive: (pid: number) => boolean;
  unlink: (path: string) => void;
}

export type ResponseStateTempRecoveryOptions = Partial<ResponseStateTempRecoveryIO> & {
  maxEntries?: number;
  maxCleanups?: number;
  /** Wall-clock ceiling for the scan, or null/undefined for no deadline (startup path). */
  deadlineMs?: number | null;
  /** Report only: apply every gate, count what would be reclaimed, unlink nothing. */
  dryRun?: boolean;
};

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled. Unknown platform errors
    // are also protected; cleanup should prefer a false negative over touching a live writer.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const responseStateTempRecoveryIO: ResponseStateTempRecoveryIO = {
  now: Date.now,
  bootTime: () => Date.now() - uptime() * 1_000,
  list: function* list(dir) {
    const handle = opendirSync(dir);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) yield entry.name;
    } finally {
      handle.closeSync();
    }
  },
  inspect: path => {
    const stat = lstatSync(path);
    return { isFile: stat.isFile() && !stat.isSymbolicLink(), mtimeMs: stat.mtimeMs, size: stat.size };
  },
  isProcessAlive: processIsAlive,
  unlink: unlinkSync,
};

/**
 * Recover only abandoned response-state atomic-write files. The exact basename,
 * regular-file check, age gate, and PID liveness check protect unrelated/active files.
 * Cleanup is capped and best-effort because continuation state is only a cache. Removal
 * deliberately uses unlink only: path-based truncation could follow a replacement symlink.
 */
export function recoverStaleResponseStateTemps(
  dir = getConfigDir(),
  options: ResponseStateTempRecoveryOptions = {},
): ResponseStateTempRecoveryResult {
  const {
    maxEntries = STALE_TEMP_MAX_ENTRIES,
    maxCleanups = STALE_TEMP_MAX_CLEANUPS,
    deadlineMs = null,
    dryRun = false,
    ...overrides
  } = options;
  const io = { ...responseStateTempRecoveryIO, ...overrides };
  const result: ResponseStateTempRecoveryResult = {
    matched: 0,
    removed: 0,
    failed: 0,
    bytesRemoved: 0,
    eligible: 0,
    eligibleBytes: 0,
    truncated: false,
  };
  const startedAt = io.now();
  // One probe per scan, not one per entry. A non-finite or future-dated boot is anomalous, and
  // clamping it to "now" would be the WORST response: the floor would then retire the liveness
  // probe for every file older than the skew, which is every file past the grace. Disable it
  // instead -- an absent floor only costs a missed reclaim, never a wrong one.
  const rawBoot = io.bootTime();
  const bootMs = Number.isFinite(rawBoot) && rawBoot <= startedAt ? rawBoot : Number.NEGATIVE_INFINITY;
  let names: Iterable<string>;
  try { names = io.list(dir); } catch { return result; }
  let iterator: Iterator<string>;
  try { iterator = names[Symbol.iterator](); } catch { return result; }
  let scanned = 0;
  // Every early exit runs through this. The production `list` is a generator that closes its
  // directory handle in a `finally`, and a `finally` does NOT run when the consumer simply
  // stops calling `next()` -- only `return()` resumes the generator to completion. Breaking
  // out of the loop directly therefore leaked one directory handle per truncated scan, and the
  // periodic reclaim truncates on purpose (entry cap, cleanup cap, deadline), so on a slow
  // filesystem that is a leak per tick, forever.
  const stopScan = (): ResponseStateTempRecoveryResult => {
    try { iterator.return?.(); } catch { /* closing is best-effort; never fail a reclaim on it */ }
    return result;
  };
  for (;;) {
    let next: IteratorResult<string>;
    try { next = iterator.next(); } catch { return result; }
    if (next.done) break;
    const name = next.value;
    scanned += 1;
    // A dry run performs no cleanups, so bounding it by the cleanup budget would truncate
    // the very report an operator uses to size the problem.
    if (scanned > maxEntries) { result.truncated = true; return stopScan(); }
    if (!dryRun && result.removed + result.failed >= maxCleanups) { result.truncated = true; return stopScan(); }
    if (deadlineMs !== null && io.now() - startedAt > deadlineMs) { result.truncated = true; return stopScan(); }
    const match = RESPONSE_STATE_TEMP_NAME.exec(name);
    if (!match) continue;
    result.matched += 1;
    const pid = Number(match[1]);
    const sequence = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(sequence) || sequence <= 0) continue;
    const path = join(dir, name);
    let file: ReturnType<ResponseStateTempRecoveryIO["inspect"]>;
    try { file = io.inspect(path); } catch { continue; }
    if (!file.isFile || io.now() - file.mtimeMs < STALE_TEMP_GRACE_MS) continue;
    // Boot floor. After a reboot the original writer's pid is routinely reused, which makes
    // the liveness skip PERMANENT: the 15-minute grace above is a lower bound and never
    // expires it, so the file is skipped on every future pass forever. A temp older than
    // this boot cannot be owned by the pid we would probe, so the probe is vacuous and we
    // retire it. This does NOT claim the file is provably dead: under a shared-volume
    // container, suspend-excluding uptime, or a network config dir the computed boot can
    // land after the real one. The unconditional 15-minute grace above remains the safety
    // floor, and this process's own temps are never touched.
    const predatesBoot = file.mtimeMs < bootMs - BOOT_FLOOR_SKEW_MS;
    if (pid === process.pid) continue;
    if (!predatesBoot && io.isProcessAlive(pid)) continue;

    result.eligible += 1;
    result.eligibleBytes += file.size;
    if (dryRun) continue;

    try {
      io.unlink(path);
      result.removed += 1;
      result.bytesRemoved += file.size;
    } catch (error) {
      // Another proxy sharing this config dir may have won the race. A file that is already
      // gone is reclaimed, not a failure -- reporting it as one would surface "in use or
      // locked" to an operator for a file nobody holds.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        result.removed += 1;
        continue;
      }
      // Locked files remain for a later startup. Do not truncate by path: a same-user
      // replacement could turn that fallback into an arbitrary symlink-target write.
      result.failed += 1;
    }
  }
  return result;
}

/**
 * Literal config dir plus the snapshot's resolved dir. Atomic writes place their temp beside
 * the RESOLVED target, so a symlinked snapshot (dotfiles-managed config dir) strands temps in
 * the link's real directory where a scan of the literal dir would never see them. The two
 * collapse to one when nothing is symlinked.
 */
function responseStateSweepDirectories(): Set<string> {
  const path = snapshotPath();
  let resolvedDir = dirname(path);
  try {
    resolvedDir = dirname(resolveWriteTarget(path));
  } catch {
    /* unresolvable link: sweep the literal dir only */
  }
  return new Set([dirname(path), resolvedDir]);
}

/**
 * Best-effort disk snapshot so previous_response_id chains survive a proxy restart (the
 * dominant expansion-miss cause: an in-memory-only store dies with the process, and the next
 * chained turn then reaches the upstream as a naked delta). Load is lazy on first store access;
 * persistence is debounced + unref'd so the hot path never blocks and the process can exit.
 * Every disk failure is swallowed — the snapshot is a cache, not a source of truth.
 */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const path = snapshotPath();
  // Atomic writes place their temp beside the RESOLVED target, so a symlinked
  // snapshot (dotfiles-managed config dir) strands temps in the link's real
  // directory where a scan of the literal config dir would never see them.
  // Both locations are swept; they collapse to one when nothing is symlinked.
  // resolveWriteTarget refuses a dangling link; snapshot loading stays independent.
  let resolvedDir = dirname(path);
  try {
    resolvedDir = dirname(resolveWriteTarget(path));
  } catch {
    /* unresolvable link: sweep the literal dir only */
  }
  for (const dir of new Set([dirname(path), resolvedDir])) {
    try {
      recoverStaleResponseStateTemps(dir);
    } catch {
      /* best-effort cleanup only; snapshot loading must remain independent */
    }
  }
  try {
    if (existsSync(path)) {
      // Bound the read BEFORE parse: the 24 MiB write cap constrains snapshots
      // this process wrote, not a pre-existing oversized file. statSync follows
      // symlinks deliberately — readFileSync below follows them too, so the
      // size gate must measure the same target the read would.
      const stat = statSync(path);
      if (!stat.isFile()) {
        // Symlink to a FIFO/device (e.g. /dev/zero): reading would block or
        // return unbounded input. Only regular files are ever parsed.
      } else if (stat.size > SNAPSHOT_FILE_MAX_BYTES) {
        admissionCounters.snapshotOversizedRefusals += 1;
      } else {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; states?: unknown };
        if ((raw.version === 1 || raw.version === 2) && Array.isArray(raw.states)) {
          for (const entry of raw.states) {
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") continue;
            loadSnapshotEntry(entry[0], entry[1]);
          }
        }
      }
    }
  } catch {
    /* missing/corrupt snapshot: start empty */
  }
  const referenced = new Set<string>();
  for (const state of states.values()) {
    if (state.kind === "spill") referenced.add(state.spill.fileName);
  }
  try { recoverOrphanedResponseSpills(referenced); } catch { /* best effort */ }
  pruneResponses();
}

type SnapshotWriteOutcome = "stable" | "unstable" | "failed";

async function writeBoundedSnapshot(path: string): Promise<SnapshotWriteOutcome> {
  // Serialize writers so concurrent flush + debounce cannot race on temps / ACL (#612).
  const previous = persistGate;
  let release!: () => void;
  persistGate = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    for (let attempt = 0; attempt < MAX_SNAPSHOT_REWRITE_ATTEMPTS; attempt += 1) {
      const revision = stateRevision;
      const entries: Array<[string, unknown]> = [];
      let total = 0;
      // Newest-first so the most recent chains survive both legacy snapshot caps.
      for (const [id, state] of [...states].reverse()) {
        let persistable: unknown;
        if (state.kind === "resident") {
          const { sizeBytes: _sizeBytes, kind: _kind, ...resident } = state;
          persistable = resident;
        } else {
          const { sizeBytes: _sizeBytes, ...smallState } = state;
          persistable = smallState;
        }
        const persistEntry: [string, unknown] = [id, persistable];
        // UTF-8 bytes, not UTF-16 code units: multibyte items otherwise slip
        // past both snapshot caps at up to 2x the intended size.
        const size = Buffer.byteLength(JSON.stringify(persistEntry), "utf8");
        if (state.kind === "resident" && size > SNAPSHOT_ENTRY_MAX_BYTES) continue;
        if (total + size > SNAPSHOT_TOTAL_MAX_BYTES) break;
        total += size;
        entries.push(persistEntry);
      }
      entries.reverse();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try { chmodSync(dirname(path), 0o700); } catch { /* best-effort (e.g. Windows) */ }
      await atomicWriteFileAsync(path, JSON.stringify({ version: 2, states: entries }));
      persistAttemptHookForTests?.();
      if (revision === stateRevision) return "stable";
    }
    return "unstable";
  } catch {
    return "failed";
  } finally {
    release();
  }
}

function drainPendingSpillUnlinks(): void {
  while (pendingSpillUnlinks.length > 0) {
    const ref = pendingSpillUnlinks.shift()!;
    deleteResponseSpill(ref);
  }
}

function schedulePersistAt(path: string, replace = false): void {
  if (persistTimer && !replace) return;
  if (persistTimer) clearTimeout(persistTimer);
  pendingPersistPath = path;
  persistTimer = setTimeout(() => { void persistNow(path); }, SNAPSHOT_DEBOUNCE_MS);
  (persistTimer as { unref?: () => void }).unref?.();
}

async function persistNow(path: string, awaitFollowUp = false): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  pendingPersistPath = null;
  let outcome = await writeBoundedSnapshot(path);
  if (outcome === "unstable" && awaitFollowUp) {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    pendingPersistPath = null;
    outcome = await writeBoundedSnapshot(path);
  }
  if (outcome === "stable") drainPendingSpillUnlinks();
  else if (outcome === "unstable" && !awaitFollowUp) schedulePersistAt(path, true);
}

function schedulePersist(): void {
  // Resolve the target path NOW: tests (and anything else) may swap OPENCODEX_HOME before the
  // debounce fires, and a late write must land in the home that owned the recorded state.
  schedulePersistAt(snapshotPath());
}

/** Flush any pending debounced snapshot write (graceful shutdown / deterministic tests). */
export async function flushResponseState(): Promise<void> {
  if (persistTimer) {
    await persistNow(pendingPersistPath ?? snapshotPath(), true);
    return;
  }
  // No pending timer: still await any in-flight write so shutdown does not race (#612).
  await persistGate;
  // A bounded background pass may have scheduled its same-path follow-up while
  // this flush was waiting on the single-flight gate. Shutdown owns one awaited
  // bounded follow-up rather than returning behind that unref'd timer.
  if (persistTimer) await persistNow(pendingPersistPath ?? snapshotPath(), true);
}

function inputItems(input: unknown): unknown[] {
  if (input === undefined) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "string") return [{ role: "user", content: input }];
  return [input];
}

/** Hard cap for canonicalizing ANY item. Past it, the item is not comparable. */
const REPLAY_FINGERPRINT_MAX_BYTES = 8 * 1024;
/** Depth ceiling so a pathologically nested item cannot blow the canonicalizer. */
const REPLAY_FINGERPRINT_MAX_DEPTH = 64;

let replayOverlapSkips = 0;

/**
 * Canonical, order-stable fingerprint for one input item, or null when the item cannot be
 * compared safely.
 *
 * Byte-counted DURING the walk rather than serialize-then-measure: a tool result can be
 * megabytes and this runs on the request path, so the point of the cap is to stop early,
 * not to discover afterwards that we should have. Object keys are sorted so two
 * semantically identical items cannot differ by key order alone.
 *
 * The cap applies to EVERY item. An `id`/`call_id` is additional occurrence evidence, never
 * a substitute for content equality, so an over-cap identified tool item is non-comparable
 * exactly like an over-cap message.
 */
function replayItemFingerprint(item: unknown): string | null {
  const out: string[] = [];
  let bytes = 0;
  const push = (text: string): boolean => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > REPLAY_FINGERPRINT_MAX_BYTES) return false;
    out.push(text);
    return true;
  };
  const walk = (value: unknown, depth: number): boolean => {
    if (depth > REPLAY_FINGERPRINT_MAX_DEPTH) return false;
    if (value === null || typeof value !== "object") return push(JSON.stringify(value) ?? "null");
    if (Array.isArray(value)) {
      if (!push("[")) return false;
      for (const element of value) {
        if (!walk(element, depth + 1)) return false;
        if (!push(",")) return false;
      }
      return push("]");
    }
    if (!push("{")) return false;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (!push(JSON.stringify(key))) return false;
      if (!walk((value as Record<string, unknown>)[key], depth + 1)) return false;
      if (!push(",")) return false;
    }
    return push("}");
  };
  return walk(item, 0) ? out.join("") : null;
}

/** Non-empty provider-issued `id`/`call_id` on an item, else null. */
function providerIssuedIdentity(item: unknown): string | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const record = item as { id?: unknown; call_id?: unknown };
  for (const candidate of [record.id, record.call_id]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return null;
}

/**
 * Number of leading stored items the client already carries verbatim, or 0.
 *
 * Requires an exact ordered run: every stored item must match the client input item at the
 * same index. Any not-comparable item aborts to 0 — skipping just that item could align two
 * different occurrences and manufacture a false positive, and a false positive here deletes
 * real conversation history.
 *
 * Known gap (FU-2): stored input can contain proxy-injected guidance the client never saw,
 * and ids repaired after recording. Those sessions do not match here and expand as before.
 */
function clientCarriedPrefixLength(stored: readonly unknown[], clientInput: readonly unknown[]): number {
  if (stored.length === 0 || clientInput.length < stored.length) return 0;
  for (let index = 0; index < stored.length; index += 1) {
    const storedPrint = replayItemFingerprint(stored[index]);
    if (storedPrint === null) return 0;
    const clientPrint = replayItemFingerprint(clientInput[index]);
    if (clientPrint === null || storedPrint !== clientPrint) return 0;
  }
  return stored.length;
}

/** Test-only: replay prepends skipped because the client already carried the history. */
export function replayOverlapSkipsForTests(): number {
  return replayOverlapSkips;
}

function pruneResponses(at = now()): void {
  for (const [id, state] of states) {
    if (at - state.createdAt > RESPONSE_TTL_MS) deleteEntry(id);
  }
  while (states.size > MAX_STORED_RESPONSES) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    deleteEntry(oldest);
  }
  // Unconditional RAM cap. Resident payloads demote durably; stubs/tombstones are
  // deleted only when even their bounded metadata cannot fit the override.
  while (storedResponseBytes > byteCap() && states.size > 0) {
    const oldestResident = [...states].find(([, entry]) => entry.kind === "resident");
    const oldestId = oldestResident?.[0] ?? states.keys().next().value as string | undefined;
    if (!oldestId) break;
    const entry = states.get(oldestId)!;
    if (entry.kind !== "resident") {
      deleteEntry(oldestId);
      continue;
    }
    try {
      const ref = writeResponseSpillDurably(oldestId, {
        createdAt: entry.createdAt,
        ...(entry.clientThreadId ? { clientThreadId: entry.clientThreadId } : {}),
        items: entry.items,
        ...(entry.providerOutputStart !== undefined ? { providerOutputStart: entry.providerOutputStart } : {}),
        ...(entry.providers ? { providers: entry.providers } : {}),
      });
      if (swapResidentForSpill(oldestId, entry, ref)) spillCounters.writes += 1;
    } catch {
      spillCounters.writeFailures += 1;
      replaceWithSpillFailure(oldestId, entry);
    }
  }
}

/** Periodic TTL-only sweep; count/byte eviction remains owned by mutation paths. */
export function sweepExpiredResponseStates(at = now()): number {
  let removed = 0;
  for (const [id, state] of states) {
    if (at - state.createdAt <= RESPONSE_TTL_MS) continue;
    deleteEntry(id);
    removed += 1;
  }
  if (removed > 0) schedulePersist();
  return removed;
}

/**
 * Periodic disk reclaim for abandoned atomic-write temps.
 *
 * `ensureLoaded` sweeps once per process, at load, BEFORE that process writes anything:
 * every `schedulePersist` site is downstream of it. So a process that abandons a temp has
 * already had its only look, the 15-minute grace hides the temp its predecessor's crash
 * just produced, and `maxCleanups` caps a single pass below a large backlog. A restart
 * loop therefore accumulates monotonically. Repeating the reclaim on a timer fixes all
 * three: the grace expires into a later tick and the per-pass cap becomes a per-tick rate.
 *
 * Registered on the sweeper's LIVENESS tick, not the TTL tick: `sweepExpiredOnWrite` puts
 * `sweepExpired` on hot write paths, and a directory scan does not belong there.
 */
export function reclaimAbandonedResponseStateTemps(
  options: ResponseStateTempRecoveryOptions = {},
): ResponseStateTempRecoveryResult {
  const total: ResponseStateTempRecoveryResult = {
    matched: 0, removed: 0, failed: 0, bytesRemoved: 0, eligible: 0, eligibleBytes: 0, truncated: false,
  };
  // The try encloses responseStateSweepDirectories() deliberately: recoverStaleResponseStateTemps
  // already swallows its own enumeration failures, so a catch around only that call would be
  // unreachable. snapshotPath()/getConfigDir() are the paths that can genuinely throw.
  try {
    for (const dir of responseStateSweepDirectories()) {
      const result = recoverStaleResponseStateTemps(dir, options);
      total.matched += result.matched;
      total.removed += result.removed;
      total.failed += result.failed;
      total.bytesRemoved += result.bytesRemoved;
      total.eligible += result.eligible;
      total.eligibleBytes += result.eligibleBytes;
      // Truncation anywhere makes the whole total a prefix.
      total.truncated ||= result.truncated;
    }
  } catch {
    /* best-effort: disk reclaim must never destabilize the caller */
  }
  return total;
}

/**
 * Report-only counterpart for `ocx doctor`: applies every selection gate and unlinks
 * nothing. It runs the SAME predicate as the reclaim, so the report and the subsequent
 * removal cannot disagree about which files are reclaimable.
 */
export function inspectAbandonedResponseStateTemps(): ResponseStateTempRecoveryResult {
  return reclaimAbandonedResponseStateTemps({ dryRun: true });
}

/** Sweeper adapter: narrows the reclaim to the `() => number` the liveness tick expects. */
export function sweepAbandonedResponseStateTemps(): number {
  return reclaimAbandonedResponseStateTemps({
    maxEntries: PERIODIC_TEMP_MAX_ENTRIES,
    maxCleanups: PERIODIC_TEMP_MAX_CLEANUPS,
    deadlineMs: PERIODIC_TEMP_SCAN_DEADLINE_MS,
  }).removed;
}

export function responseContinuationRetainedStoreSnapshot(): RetainedStoreSnapshot {
  return {
    count: states.size,
    bytes: storedResponseBytes,
    evictableBytes: residentResponseBytes,
    pinnedBytes: Math.max(0, storedResponseBytes - residentResponseBytes),
    oldestAt: oldestResidentAt,
  };
}

export function evictOldestResponseContinuationForBudget(): number {
  if (oldestResidentId === undefined) return 0;
  const id = oldestResidentId;
  const entry = states.get(id);
  if (!entry || entry.kind !== "resident") return 0;
  try {
    const ref = writeResponseSpillDurably(id, {
      createdAt: entry.createdAt,
      ...(entry.clientThreadId ? { clientThreadId: entry.clientThreadId } : {}),
      items: entry.items,
      ...(entry.providerOutputStart !== undefined ? { providerOutputStart: entry.providerOutputStart } : {}),
      ...(entry.providers ? { providers: entry.providers } : {}),
    });
    if (swapResidentForSpill(id, entry, ref)) spillCounters.writes += 1;
  } catch {
    spillCounters.writeFailures += 1;
    replaceWithSpillFailure(id, entry);
  }
  schedulePersist();
  const replacement = states.get(id);
  return !replacement || replacement.kind === "resident"
    ? 0
    : Math.max(0, entry.sizeBytes - replacement.sizeBytes);
}

function materializeEntry(
  id: string,
  entry: StoredResponseState,
): { ok: true; state: ResidentResponseState } | { ok: false; failure: PreviousResponseReplayFailure } {
  if (entry.kind === "resident") return { ok: true, state: entry };
  if (entry.kind === "spill-failed") {
    return { ok: false, failure: { code: "previous_response_not_found", reason: "spill_failed" } };
  }
  const result = readResponseSpill(id, entry.spill);
  if (!result.ok) {
    spillCounters.readFailures += 1;
    const failure: PreviousResponseReplayFailure = {
      code: "previous_response_not_found",
      reason: result.reason === "missing"
        ? "spill_missing"
        : result.reason === "too_large"
          ? "spill_too_large"
          : "spill_corrupt",
    };
    replaceWithSpillFailure(id, entry);
    schedulePersist();
    return { ok: false, failure };
  }
  const state = measureResidentEntry(id, {
    createdAt: result.payload.createdAt,
    ...(result.payload.clientThreadId ? { clientThreadId: result.payload.clientThreadId } : {}),
    items: result.payload.items,
    ...(result.payload.providerOutputStart !== undefined
      ? { providerOutputStart: result.payload.providerOutputStart }
      : {}),
    ...(result.payload.providers ? { providers: result.payload.providers } : {}),
  });
  if (!state) {
    spillCounters.readFailures += 1;
    replaceWithSpillFailure(id, entry);
    schedulePersist();
    return { ok: false, failure: { code: "previous_response_not_found", reason: "spill_corrupt" } };
  }
  return { ok: true, state };
}

function normalizedClientThreadId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function withoutPreviousResponseId(request: Record<string, unknown>): Record<string, unknown> {
  const { previous_response_id: _previousResponseId, ...freshRequest } = request;
  return freshRequest;
}

export function expandPreviousResponseInput(body: unknown, clientThreadId?: string): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const request = body as Record<string, unknown>;
  const previousId = typeof request.previous_response_id === "string" ? request.previous_response_id : undefined;
  if (!previousId) return body;
  ensureLoaded();
  pruneResponses();
  const previous = states.get(previousId);
  if (!previous) return body;
  const materialized = materializeEntry(previousId, previous);
  if (!materialized.ok) {
    replayFailures.set(request, materialized.failure);
    return body;
  }
  const requestThreadId = normalizedClientThreadId(clientThreadId);
  const storedThreadId = normalizedClientThreadId(materialized.state.clientThreadId);
  // A Codex task must never inherit another task's continuation, nor a legacy unscoped entry.
  // Unscoped callers retain backward-compatible replay only with other unscoped entries.
  if (requestThreadId !== storedThreadId) {
    const freshRequest = withoutPreviousResponseId(request);
    replayScopeMismatches.add(freshRequest);
    replayScopeMismatchDrops += 1;
    return freshRequest;
  }
  // The client already replayed this history verbatim. Prepending the stored copy would
  // double it, and the doubled turn is stored again, so the next turn triples (#1412 saw
  // 127k of real context reach 1.3M tokens this way).
  //
  // Three conditions, all required. The run must cover the whole stored entry; it must reach
  // the provider-output region; and some matched item in that region must carry a
  // provider-issued id. The last one is the load-bearing part: content equality alone proves
  // two items look alike, not that they are the same occurrence, so a client that merely
  // repeats its own message would otherwise authorize a skip that deletes real history.
  // There is no invariant that provider output always carries ids, so an entry whose output
  // has none simply never skips.
  {
    const clientInput = inputItems(request.input);
    const stored = materialized.state.items;
    const anchor = materialized.state.providerOutputStart;
    const carried = clientCarriedPrefixLength(stored, clientInput);
    if (
      carried === stored.length
      && anchor !== undefined
      && carried > anchor
      && stored.slice(anchor, carried).some(item => providerIssuedIdentity(item) !== null)
    ) {
      replayOverlapSkips += 1;
      // Keep previous_response_id: Kiro and Cursor recover their conversation ids from it
      // (kiro-wire.ts, cursor/request-builder.ts). Only the concatenation is skipped.
      const unchanged = { ...request };
      // Same provenance boundary a real expansion would record, so the replayed prefix does
      // not re-acknowledge historical compaction markers (parser.ts) and stays visible to
      // guidance de-duplication (collaboration.ts).
      replayedInputPrefixLengths.set(unchanged, carried);
      return unchanged;
    }
  }
  const expanded = {
    ...request,
    input: [...materialized.state.items, ...inputItems(request.input)],
  };
  replayedInputPrefixLengths.set(expanded, materialized.state.items.length);
  return expanded;
}

export function previousResponseReplayFailure(body: unknown): PreviousResponseReplayFailure | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  return replayFailures.get(body);
}

/** Number of leading input items restored from previous_response_id state for this exact body. */
export function previousResponseReplayPrefixLength(body: unknown): number {
  if (!body || typeof body !== "object" || Array.isArray(body)) return 0;
  return replayedInputPrefixLengths.get(body) ?? 0;
}

/** Copy proxy-private replay provenance to an internal clone with the same materialized input. */
export function copyPreviousResponseReplayProvenance(source: unknown, target: unknown): void {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  if (!target || typeof target !== "object" || Array.isArray(target)) return;
  const prefixLength = replayedInputPrefixLengths.get(source);
  if (!prefixLength) return;
  const input = (target as { input?: unknown }).input;
  if (!Array.isArray(input) || prefixLength > input.length) return;
  replayedInputPrefixLengths.set(target, prefixLength);
}

/** True when a stale or foreign previous_response_id was removed from this exact request body. */
export function previousResponseScopeMismatch(body: unknown): boolean {
  return !!body && typeof body === "object" && replayScopeMismatches.has(body as object);
}

export function previousResponseConversationId(responseId: string | undefined): string | undefined {
  return previousResponseProviderState(responseId)?.cursor?.conversationId;
}

export function previousResponseProviderState(responseId: string | undefined): OcxProviderContinuationState | undefined {
  if (!responseId) return undefined;
  ensureLoaded();
  pruneResponses();
  const state = states.get(responseId);
  const providers = state?.kind === "spill-failed" ? undefined : state?.providers;
  return providers ? structuredClone(providers) : undefined;
}

export interface ResponseStateMetrics {
  count: number;
  residentCount: number;
  spillStubCount: number;
  tombstoneCount: number;
  totalBytes: number;
  spillPayloadBytes: number;
  largestBytes: number;
  oldestAgeMs: number;
  spillWrites: number;
  spillWriteFailures: number;
  spillReadFailures: number;
  replayScopeMismatchDrops: number;
}

/**
 * Observe-only snapshot of the in-RAM continuation store, surfaced via GET /api/system/memory.
 * Additive and side-effect free — it does NOT lazy-load the disk snapshot, prune, or evict — so a
 * diagnostics probe can sample it without perturbing request handling. `totalBytes` reads the
 * running byte counter and `largestBytes` reads each entry's cached `sizeBytes`, so a probe never
 * re-serializes the whole store (a large transient allocation that would fire exactly when memory
 * is already under pressure). This is the seam for deciding whether RAM growth originates in this
 * store (JS heap) or in the runtime allocator (native).
 */
export function responseStateMetrics(): ResponseStateMetrics {
  const at = now();
  let largestBytes = 0;
  let oldestCreatedAt = at;
  let residentCount = 0;
  let spillStubCount = 0;
  let tombstoneCount = 0;
  let spillPayloadBytes = 0;
  for (const state of states.values()) {
    const bytes = state.sizeBytes;
    if (bytes > largestBytes) largestBytes = bytes;
    if (state.createdAt < oldestCreatedAt) oldestCreatedAt = state.createdAt;
    if (state.kind === "resident") {
      residentCount += 1;
    } else if (state.kind === "spill") {
      spillStubCount += 1;
      spillPayloadBytes += state.spill.payloadBytes;
    } else tombstoneCount += 1;
  }
  return {
    count: states.size,
    residentCount,
    spillStubCount,
    tombstoneCount,
    totalBytes: storedResponseBytes,
    spillPayloadBytes,
    largestBytes,
    oldestAgeMs: states.size > 0 ? at - oldestCreatedAt : 0,
    spillWrites: spillCounters.writes,
    spillWriteFailures: spillCounters.writeFailures,
    spillReadFailures: spillCounters.readFailures,
    replayScopeMismatchDrops,
  };
}

/**
 * Cache completed output and max_output_tokens partial output for previous_response_id replay.
 * Content-filtered incomplete and failed output are not authoritative replay history.
 */
/**
 * Request bodies that must never enter the continuation cache.
 *
 * The cache is persisted to `responses-state.json`, so anything recorded here reaches disk.
 * Encrypted-agent-task recovery decrypts task text into the request body and promises
 * in-memory, TTL-bounded retention; recording that body would put the plaintext on disk with
 * no TTL and break the promise.
 *
 * A WeakSet rather than a body field on purpose: `_rawBody` is serialized verbatim by the
 * native passthrough, so any marker written into the body itself would be sent upstream.
 * Marking is enforced once here rather than at each call site, because every recording path
 * (streaming, non-streaming, passthrough, forced) funnels through `rememberResponseState` —
 * a new call site cannot reintroduce the leak by forgetting a guard.
 */
const nonPersistableBodies = new WeakSet<object>();

/** Bar this exact request body from the continuation cache, and therefore from disk. */
export function markBodyNonPersistable(body: unknown): void {
  if (body && typeof body === "object") nonPersistableBodies.add(body as object);
}

export function rememberResponseState(
  requestBody: unknown,
  response: { id?: unknown; output?: unknown; status?: unknown; incomplete_details?: unknown },
  providerState?: OcxProviderContinuationState | string,
  opts?: { force?: boolean; clientThreadId?: string },
): void {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return;
  const request = requestBody as Record<string, unknown>;
  if (nonPersistableBodies.has(request)) return;
  // `force` bypasses only the store:false skip: Codex sends `store:false` on every non-Azure
  // HTTP request (and WS inherits it), yet its WS turns still chain with previous_response_id.
  // The passthrough branch records with force so those chains can be expanded locally; the
  // store stays in-memory with a 1h TTL, so this is a proxy-internal continuation cache, not
  // real server-side response storage.
  if (request.store === false && !opts?.force) return;
  if (typeof response.id !== "string" || !Array.isArray(response.output)) return;
  if (response.status === "incomplete") {
    const details = response.incomplete_details;
    if (!details || typeof details !== "object" || Array.isArray(details)
      || (details as { reason?: unknown }).reason !== "max_output_tokens") return;
  } else if (response.status !== undefined && response.status !== "completed") return;
  ensureLoaded();
  const normalizedProviderState: OcxProviderContinuationState = typeof providerState === "string"
    ? { cursor: { conversationId: providerState } }
    : structuredClone(providerState ?? {});
  if (normalizedProviderState.cursor?.conversationId) {
    normalizedProviderState.cursor.checkpointUsable = !response.output.some(item => {
      return !!item && typeof item === "object" && (item as { type?: unknown }).type === "function_call";
    });
  }
  const clientThreadId = normalizedClientThreadId(opts?.clientThreadId);
  // Compute the normalized array once and reuse it for both fields, so the recorded
  // boundary can never disagree with the items it indexes.
  const requestItems = inputItems(request.input);
  setResidentEntry(response.id, {
    createdAt: now(),
    ...(clientThreadId ? { clientThreadId } : {}),
    items: [...requestItems, ...response.output],
    // Where response.output begins. A replay skip requires a matched item at or past this
    // index that also carries a provider-issued id — position alone proves only that an item
    // sits on the provider side, not that the provider authored it.
    providerOutputStart: requestItems.length,
    // Always preserve the Cursor conversation id so the next tool-result turn can continue the SAME
    // Cursor conversation (multi-turn continuation). Separately track whether Cursor's own
    // checkpoint/cache is safe to reuse: a turn that ended with a pending client tool call produced an
    // incomplete agent turn on the Cursor side (we suspended without a real mcpResult), so its
    // checkpoint must not be reused — but the conversation id string itself is still valid.
    ...(Object.keys(normalizedProviderState).length > 0 ? { providers: normalizedProviderState } : {}),
  });
  enforceAppOwnedMemoryBudget();
  schedulePersist();
}

/** Test-only persistence churn hook; invoked after each atomic snapshot rewrite. */
export function setResponseStatePersistAttemptHookForTests(hook: (() => void) | null): void {
  persistAttemptHookForTests = hook;
}

/** Test-only: deterministically run the pending background debounce pass. */
export async function runPendingResponseStatePersistForTests(): Promise<void> {
  if (!persistTimer) return;
  await persistNow(pendingPersistPath ?? snapshotPath());
}

/** Test-only: observe whether a debounce/follow-up pass is pending. */
export function responseStatePersistPendingForTests(): boolean {
  return persistTimer !== null;
}

/** Memory-only reset (simulates a process restart: the snapshot file survives). */
export function clearResponseStateMemoryForTests(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  pendingPersistPath = null;
  states.clear();
  storedResponseBytes = 0;
  residentResponseBytes = 0;
  oldestResidentId = undefined;
  oldestResidentAt = null;
  stateRevision = 0;
  pendingSpillUnlinks.length = 0;
  spillCounters.writes = 0;
  spillCounters.writeFailures = 0;
  spillCounters.readFailures = 0;
  replayScopeMismatchDrops = 0;
  replayOverlapSkips = 0;
  persistAttemptHookForTests = null;
  loaded = false;
}

export function clearResponseStateForTests(): void {
  for (const entry of states.values()) deleteOwnedSpills(entry);
  clearResponseStateMemoryForTests();
  try {
    unlinkSync(snapshotPath());
  } catch {
    /* no snapshot on disk */
  }
  try { rmSync(responseSpillDirectory(), { recursive: true, force: true }); } catch { /* no spill directory */ }
}
