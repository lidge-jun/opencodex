import { chmodSync, existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileAsync, getConfigDir } from "../config";
import { enforceAppOwnedMemoryBudget, type RetainedStoreSnapshot } from "../lib/app-owned-memory";
import type { OcxProviderContinuationState } from "../types";
import {
  deleteResponseSpill,
  noteStubSwapForTest,
  readResponseSpill,
  recoverOrphanedResponseSpills,
  responseSpillDirectory,
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
const STALE_TEMP_GRACE_MS = 15 * 60 * 1_000;
const STALE_TEMP_MAX_ENTRIES = 4_096;
const STALE_TEMP_MAX_CLEANUPS = 512;
const RESPONSE_STATE_TEMP_NAME = /^responses-state\.json\.ocx\.(\d+)\.(\d+)\.tmp$/;
const MAX_SNAPSHOT_REWRITE_ATTEMPTS = 4;

interface ResidentResponseState {
  kind: "resident";
  createdAt: number;
  items: unknown[];
  providers?: OcxProviderContinuationState;
  sizeBytes: number;
}

interface SpilledResponseState {
  kind: "spill";
  createdAt: number;
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
  reason: "spill_missing" | "spill_corrupt" | "spill_failed";
};

const states = new Map<string, StoredResponseState>();
let storedResponseBytes = 0;
let residentResponseBytes = 0;
let oldestResidentId: string | undefined;
let oldestResidentAt: number | null = null;
let byteCapOverride: number | null = null;
let stateRevision = 0;
const spillCounters = { writes: 0, writeFailures: 0, readFailures: 0 };
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
    items: entry.items,
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

function replaceWithSpillFailure(id: string, expected?: StoredResponseState): void {
  const existing = states.get(id);
  if (expected && existing !== expected) return;
  const failed = tombstone(id, expected?.createdAt ?? existing?.createdAt ?? now());
  if (replaceMapEntry(id, failed, expected)) {
    if (existing) deleteOwnedSpills(existing);
  }
}

function swapResidentForSpill(id: string, expected: ResidentResponseState, ref: ResponseSpillRef): boolean {
  const base: Omit<SpilledResponseState, "sizeBytes"> = {
    kind: "spill",
    createdAt: expected.createdAt,
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
      items: candidate.items,
      ...(candidate.providers ? { providers: candidate.providers } : {}),
    });
    const base: Omit<SpilledResponseState, "sizeBytes"> = {
      kind: "spill",
      createdAt: candidate.createdAt,
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
    replaceWithSpillFailure(id, expected);
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
  if (expected?.kind === "spill") {
    replaceSpillEntryAtomically(id, expected, candidate);
    pruneResponses();
    return;
  }
  if (!replaceMapEntry(id, candidate, expected)) return;
  pruneResponses();
}

// Expansion provenance must stay proxy-private: a WeakMap distinguishes replayed history from the
// newly appended input suffix without adding an unknown field that native passthrough could send
// upstream. The parser uses this boundary to acknowledge historical compaction markers exactly once.
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
  if (rec.kind === "spill") {
    if (!isSpillRef(rec.spill)) return;
    const base: Omit<SpilledResponseState, "sizeBytes"> = {
      kind: "spill",
      createdAt: rec.createdAt,
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
    items: rec.items,
    ...(providers ? { providers } : {}),
  });
  if (resident) replaceMapEntry(id, resident);
  else replaceMapEntry(id, tombstone(id, rec.createdAt));
}

export interface ResponseStateTempRecoveryResult {
  matched: number;
  removed: number;
  failed: number;
  bytesRemoved: number;
}

interface ResponseStateTempRecoveryIO {
  now: () => number;
  list: (dir: string) => Iterable<string>;
  inspect: (path: string) => { isFile: boolean; mtimeMs: number; size: number };
  isProcessAlive: (pid: number) => boolean;
  unlink: (path: string) => void;
}

type ResponseStateTempRecoveryOptions = Partial<ResponseStateTempRecoveryIO> & {
  maxEntries?: number;
  maxCleanups?: number;
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
  const { maxEntries = STALE_TEMP_MAX_ENTRIES, maxCleanups = STALE_TEMP_MAX_CLEANUPS, ...overrides } = options;
  const io = { ...responseStateTempRecoveryIO, ...overrides };
  const result: ResponseStateTempRecoveryResult = {
    matched: 0,
    removed: 0,
    failed: 0,
    bytesRemoved: 0,
  };
  let names: Iterable<string>;
  try { names = io.list(dir); } catch { return result; }
  let iterator: Iterator<string>;
  try { iterator = names[Symbol.iterator](); } catch { return result; }
  let scanned = 0;
  for (;;) {
    let next: IteratorResult<string>;
    try { next = iterator.next(); } catch { return result; }
    if (next.done) break;
    const name = next.value;
    scanned += 1;
    if (scanned > maxEntries || result.removed + result.failed >= maxCleanups) break;
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
    if (pid === process.pid || io.isProcessAlive(pid)) continue;

    try {
      io.unlink(path);
      result.removed += 1;
      result.bytesRemoved += file.size;
    } catch {
      // Locked files remain for a later startup. Do not truncate by path: a same-user
      // replacement could turn that fallback into an arbitrary symlink-target write.
      result.failed += 1;
    }
  }
  return result;
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
  try {
    recoverStaleResponseStateTemps(dirname(path));
  } catch {
    /* best-effort cleanup only; snapshot loading must remain independent */
  }
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; states?: unknown };
      if ((raw.version === 1 || raw.version === 2) && Array.isArray(raw.states)) {
        for (const entry of raw.states) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") continue;
          loadSnapshotEntry(entry[0], entry[1]);
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
        const size = JSON.stringify(persistEntry).length;
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
        items: entry.items,
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
      items: entry.items,
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
      reason: result.reason === "missing" ? "spill_missing" : "spill_corrupt",
    };
    replaceWithSpillFailure(id, entry);
    schedulePersist();
    return { ok: false, failure };
  }
  const state = measureResidentEntry(id, {
    createdAt: result.payload.createdAt,
    items: result.payload.items,
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

export function expandPreviousResponseInput(body: unknown): unknown {
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
  };
}

/**
 * Cache completed output and max_output_tokens partial output for previous_response_id replay.
 * Content-filtered incomplete and failed output are not authoritative replay history.
 */
export function rememberResponseState(
  requestBody: unknown,
  response: { id?: unknown; output?: unknown; status?: unknown; incomplete_details?: unknown },
  providerState?: OcxProviderContinuationState | string,
  opts?: { force?: boolean },
): void {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return;
  const request = requestBody as Record<string, unknown>;
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
  setResidentEntry(response.id, {
    createdAt: now(),
    items: [...inputItems(request.input), ...response.output],
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
