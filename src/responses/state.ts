import { chmodSync, existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFileAsync, getConfigDir, resolveWriteTarget } from "../config";
import { enforceAppOwnedMemoryBudget, type RetainedStoreSnapshot } from "../lib/app-owned-memory";
import { windowsSecretAclApplies } from "../lib/windows-secret-acl";
import type { OcxProviderContinuationState } from "../types";
import {
  cleanupSupersededResponseSpillPublication,
  createResponseSpillPublicationControl,
  deleteResponseSpill,
  MAX_RESPONSE_SPILL_PAYLOAD_BYTES,
  noteStubSwapForTest,
  readResponseSpill,
  recoverOrphanedResponseSpills,
  responseSpillDirectory,
  responseSpillPayloadCap,
  markResponseSpillPublicationSuperseded,
  prospectiveResponseSpillBytes,
  type ResponseSpillPublicationControl,
  type ResponseSpillRef,
  writeResponseSpillDurably,
  writeResponseSpillDurablyAsync,
} from "./spill-store";

const MAX_STORED_RESPONSES = 1_000;
const RESPONSE_TTL_MS = 60 * 60 * 1_000;
const SNAPSHOT_DEBOUNCE_MS = 2_000;
/** Snapshot size below which the debounce stays at its base value. */
const SNAPSHOT_DEBOUNCE_SCALE_FROM_BYTES = 1 * 1024 * 1024;
/** Ceiling for the stretched debounce. Continuation state is only read after a
 *  restart, and a graceful shutdown flushes, so the exposure a longer debounce adds
 *  is bounded by a hard kill — paid against rewriting the whole snapshot every 2 s. */
const SNAPSHOT_DEBOUNCE_MAX_MS = 30_000;
/** In-memory high-water byte cap across all entries. Forced store:false retention (kiro/cursor
 * continuation chains) stores the full expanded input each turn — ~quadratic bytes per chain —
 * so a count cap alone cannot bound memory. Oldest-first eviction applies past this mark. */
export const MAX_STORED_RESPONSE_BYTES = 64 * 1024 * 1024;
/**
 * Aggregate ceiling for the durable spill directory: the disk-side counterpart to
 * the RAM ceiling above. Without it the spilled set is bounded only per-file
 * (MAX_RESPONSE_SPILL_PAYLOAD_BYTES, 256 MiB) and per-entry (MAX_STORED_RESPONSES,
 * 1000), whose product is 250 GiB — larger than the disk of any host this runs on.
 * The only effective bound was therefore RESPONSE_TTL_MS, which makes disk use a
 * function of client request rate rather than of anything this process controls.
 *
 * Measured on one macOS host, 2026-08-30: a client spilling ~150 MB payloads at
 * ~1.4/min held 6.8 GB after 44 minutes, still climbing toward the ~12 GB an
 * hour-long window implies, and filled the volume. Retention itself was correct
 * throughout — the TTL evicted that whole cohort an hour later — so what was
 * missing is a budget, not a sweep.
 *
 * 1 GiB comes from the same sample (n=31), whose spilled sizes are strongly
 * bimodal: median 1.1 MiB against a p90 of 198.7 MiB, near the per-file ceiling.
 * At that median the count cap and this ceiling bind within 8% of each other
 * (1000 x 1.1 MiB = 1.07 GiB), so ordinary traffic sees no eviction it would not
 * already have seen and only the large tail is cut. Erring small is the safe
 * direction: too low costs a replay miss, an already-handled path surfaced as
 * previous_response_not_found, while too high costs the host's disk and every
 * unrelated process on it.
 */
export const MAX_SPILLED_RESPONSE_BYTES = 1024 * 1024 * 1024;
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
const RESPONSE_SPILL_SHUTDOWN_BUDGET_MS = 5_000;
const RESPONSE_SPILL_SHUTDOWN_FALLBACK_RESERVE_MS = 4_000;
const RESPONSE_SPILL_ASYNC_ACL_ATTEMPT_BUDGET_MS = 30_000;
const RESPONSE_SPILL_SHUTDOWN_TERMINALIZATION_MAX_PASSES = MAX_STORED_RESPONSES + 1;

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
/** Byte length and digest of the last snapshot actually written, for the
 *  identical-payload skip and the size-scaled debounce. The payload itself is not
 *  retained: at the 24 MiB bound that would double the snapshot's memory cost. */
let lastSnapshotBytes = 0;
let lastSnapshotDigest: string | null = null;
// The resolved file the digest above describes. Keeping it means a config-dir
// change or a retargeted symlink is a miss rather than a false "unchanged".
let lastSnapshotTarget: string | null = null;

/**
 * Is the snapshot on disk still byte-for-byte what we last wrote?
 *
 * The cached digest proves what this process wrote, not what is there now. Size is
 * checked first so the common mismatch costs a `stat`, and the content comparison
 * only runs when the size already agrees. Any read failure answers "no" and the
 * caller rewrites — the safe direction.
 */
async function snapshotOnDiskMatches(path: string, payload: string, payloadBytes: number): Promise<boolean> {
  try {
    const file = Bun.file(path);
    if (file.size !== payloadBytes) return false;
    if (await file.text() !== payload) return false;
    // Content matching is not the whole invariant. This file holds persisted request
    // and response bodies, and `atomicWriteFileAsync` writes it owner-only; the
    // unconditional rewrite used to restore that on every mutation. Skipping without
    // checking would let a broadened mode persist indefinitely, so treat a widened
    // file as "does not match" and let the caller rewrite it through the hardening
    // path. POSIX only — Windows ACLs are re-applied by that same write path.
    if (process.platform !== "win32") {
      const mode = statSync(path).mode & 0o777;
      if (mode !== 0o600) return false;
    }
    return true;
  } catch {
    return false;
  }
}
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

/**
 * Windows keeps the candidate replayable while required ACL hardening runs off the event loop.
 * Pending bytes are pinned, not evictable; cap them below the process-owned 512 MiB ceiling so an
 * icacls outage cannot turn the serialized queue into an unbounded resident backlog.
 */
const MAX_PENDING_RESPONSE_SPILL_BYTES = MAX_RESPONSE_SPILL_PAYLOAD_BYTES;

interface PendingResponseSpill {
  id: string;
  candidate: ResidentResponseState | null;
  supersededSpill?: ResponseSpillRef;
  directAdmission: boolean;
  running: boolean;
  cancelled: boolean;
  released: boolean;
  sizeBytes: number;
  /** Peak on-disk bytes reserved for this publication; released exactly once on settle. */
  reservedBytes: number;
  publicationControl: ResponseSpillPublicationControl;
}

const pendingResponseSpills = new Set<PendingResponseSpill>();
const pendingResponseSpillById = new Map<string, PendingResponseSpill>();
let pendingResponseSpillBytes = 0;
/**
 * On-disk bytes a queued publication is about to occupy but has not yet installed into
 * `states`.
 *
 * `spilledResponseBytes()` walks installed spills and deferred unlinks — files that
 * already exist. It cannot see one that `writeResponseSpillDurablyAsync` is in the
 * middle of creating, and on Windows that middle can last as long as `icacls` takes.
 * Without a reservation the cap holds only when writes are fast, which is not a cap.
 *
 * The reserved figure is the PEAK footprint, not the payload: publication can fall back
 * from hard-linking to an exclusive copy, and during that fallback the destination copy
 * and the temp file exist simultaneously. Reserving one envelope would leave the overshoot
 * intact at half its magnitude.
 *
 * Ownership is single: a job holds its reservation from queue until
 * `releasePendingResponseSpill`, which every exit from the publication path reaches
 * through the `finally` in `runPendingResponseSpill` and through cancellation of a
 * not-yet-running job. A leaked reservation is monotonic — it would ratchet the usable
 * cap toward zero — so the release must stay on the settlement path rather than in a
 * parallel bookkeeping pass.
 */
let reservedResponseSpillBytes = 0;
/**
 * Paths a failed cleanup left on the volume, with the bytes each one occupies.
 *
 * A failed unlink leaves a real file behind, so the cap has to keep seeing it. But a
 * never-decremented total would be phantom debt: a Windows lock that clears a moment
 * later, or the async writer's own retry, can remove the file while the charge stays
 * forever — and with 256 MiB payloads two conservative charges consume the whole default
 * cap, after which nothing can spill for the life of the process.
 *
 * So the debt is per PATH, priced at what that path actually holds, and settled the
 * moment the path is gone. `reconcileUnreclaimableSpillPaths` re-checks on every read of
 * the accounted total, which is the same tick that would otherwise refuse an admission.
 */
const unreclaimableSpillPaths = new Map<string, number>();

function chargeUnreclaimableSpillPath(path: string | null | undefined, bytes: number): void {
  if (!path || bytes <= 0) return;
  unreclaimableSpillPaths.set(path, bytes);
}

/** Drop charges for paths that have since disappeared; returns the surviving total. */
function reconcileUnreclaimableSpillPaths(): number {
  let total = 0;
  for (const [path, bytes] of [...unreclaimableSpillPaths]) {
    if (existsSync(path)) total += bytes;
    else unreclaimableSpillPaths.delete(path);
  }
  return total;
}

/**
 * Peak on-disk footprint of publishing this candidate: temp plus destination copy.
 *
 * Measured from the production serializer rather than from `candidate.sizeBytes`. The
 * resident measurement omits the `version` field the published envelope carries, so
 * pricing an admission by it undercounts and lets a request sitting exactly at the cap
 * still exceed it. Falls back to the resident figure only when serialization fails, which
 * is the same condition that will fail the publication itself.
 */
function publicationFootprintBytes(id: string, candidate: ResidentResponseState): number {
  const exact = prospectiveResponseSpillBytes(id, spillPayloadForResident(candidate));
  return (exact ?? candidate.sizeBytes) * 2;
}
let responseSpillPublicationTail: Promise<void> = Promise.resolve();
let responseSpillShutdownBudgetOverride: { totalMs: number; fallbackReserveMs: number } | null = null;
let responseSpillShutdownTerminalizationPassLimitOverride: number | null = null;
let responseSpillAsyncAclAttemptBudgetOverride: number | null = null;

function deferSupersededSpill(ref: ResponseSpillRef | undefined): void {
  if (!ref) return;
  pendingSpillUnlinks.push(ref);
  while (pendingSpillUnlinks.length > PENDING_SPILL_UNLINKS_MAX) {
    deleteResponseSpill(pendingSpillUnlinks.shift()!);
  }
}

function releasePendingResponseSpill(job: PendingResponseSpill): void {
  if (job.released) return;
  job.released = true;
  pendingResponseSpillBytes = Math.max(0, pendingResponseSpillBytes - job.sizeBytes);
  reservedResponseSpillBytes = Math.max(0, reservedResponseSpillBytes - job.reservedBytes);
  pendingResponseSpills.delete(job);
  if (pendingResponseSpillById.get(job.id) === job) pendingResponseSpillById.delete(job.id);
  job.candidate = null;
}

function cancelPendingResponseSpill(id: string): ResponseSpillRef | undefined {
  const job = pendingResponseSpillById.get(id);
  if (!job) return undefined;
  pendingResponseSpillById.delete(id);
  job.cancelled = true;
  markResponseSpillPublicationSuperseded(job.publicationControl);
  const superseded = job.supersededSpill;
  // Ownership TRANSFERS to the caller. Leaving the ref on the cancelled job would let the
  // accounting walk count the same physical file twice — once here and once on the
  // replacement — and an overcount evicts live continuations to make room for bytes that
  // are not there.
  delete job.supersededSpill;
  // A queued job has not captured the candidate in an async frame yet, so release it now.
  // A running job retains its accounting until settlement and will discard its stale file.
  if (!job.running) releasePendingResponseSpill(job);
  return superseded;
}

function isAclTimeout(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error
    && String((error as { code?: unknown }).code) === "ETIMEDOUT";
}

function spillPayloadForResident(candidate: ResidentResponseState): Parameters<typeof writeResponseSpillDurably>[1] {
  return {
    createdAt: candidate.createdAt,
    ...(candidate.clientThreadId ? { clientThreadId: candidate.clientThreadId } : {}),
    items: candidate.items,
    ...(candidate.providerOutputStart !== undefined ? { providerOutputStart: candidate.providerOutputStart } : {}),
    ...(candidate.providers ? { providers: candidate.providers } : {}),
  };
}

async function runPendingResponseSpill(job: PendingResponseSpill): Promise<void> {
  if (job.cancelled || !job.candidate) return;
  job.running = true;
  const candidate = job.candidate;
  let ref: ResponseSpillRef | null = null;
  try {
    const state = spillPayloadForResident(candidate);
    try {
      ref = await writeResponseSpillDurablyAsync(job.id, state, {
        aclBudgetMs: responseSpillAsyncAclAttemptBudgetMs(),
        publicationControl: job.publicationControl,
      });
    } catch (error) {
      if (!isAclTimeout(error)) throw error;
      // The ACL helper permits exactly one caller-owned recovery budget. The resident generation
      // remains replayable during both attempts, so a transient timeout never becomes a tombstone.
      ref = await writeResponseSpillDurablyAsync(job.id, state, {
        aclBudgetMs: responseSpillAsyncAclAttemptBudgetMs(),
        retryTimedOutOnce: true,
        publicationControl: job.publicationControl,
      });
    }
    if (ref.payloadBytes > responseSpillPayloadCap()) {
      deleteResponseSpill(ref);
      ref = null;
      if (job.directAdmission) admissionCounters.oversizedDrops += 1;
      throw Object.assign(new Error("Response spill payload exceeds replay ceiling"), { code: "EFBIG" });
    }
    if (states.get(job.id) !== candidate || job.cancelled) {
      deleteResponseSpill(ref);
      ref = null;
      return;
    }
    if (swapResidentForSpill(job.id, candidate, ref)) {
      ref = null;
      spillCounters.writes += 1;
      if (job.directAdmission) admissionCounters.directSpills += 1;
      deferSupersededSpill(job.supersededSpill);
    }
  } catch {
    if (ref) deleteResponseSpill(ref);
    if (states.get(job.id) === candidate && !job.cancelled) {
      spillCounters.writeFailures += 1;
      replaceWithSpillFailure(job.id, candidate);
      deferSupersededSpill(job.supersededSpill);
    }
  } finally {
    const cancelled = job.cancelled;
    releasePendingResponseSpill(job);
    recomputeOldestResident();
    if (!cancelled) {
      schedulePersist();
      pruneResponses();
      enforceAppOwnedMemoryBudget();
    }
  }
}

function queuePendingResponseSpill(
  id: string,
  candidate: ResidentResponseState,
  options: { supersededSpill?: ResponseSpillRef; directAdmission?: boolean } = {},
): void {
  const inheritedSpill = cancelPendingResponseSpill(id) ?? options.supersededSpill;
  if (pendingResponseSpillBytes + candidate.sizeBytes > MAX_PENDING_RESPONSE_SPILL_BYTES) {
    spillCounters.writeFailures += 1;
    replaceWithSpillFailure(id, candidate);
    deferSupersededSpill(inheritedSpill);
    return;
  }
  // Enforce the disk cap BEFORE the temp or destination file is created. Deleting the
  // overflow afterwards is not equivalent: on Windows the file can outlive the decision
  // by as long as ACL hardening takes, which is the window the measured 6.8 GiB
  // accumulated in. Reclaim first, and only refuse if the peak footprint still does not
  // fit — an eviction pass can free a live continuation's worth of room.
  const footprint = publicationFootprintBytes(id, candidate);
  // The superseded generation this job is about to own is already off `states` and not
  // yet on the job, so it is invisible to the walk. Price it here or admission decides
  // against a total that is short by a whole envelope.
  const inheritedBytes = inheritedSpill?.payloadBytes ?? 0;
  if (accountedResponseSpillBytes() + footprint + inheritedBytes > spillByteCap()) {
    enforceSpilledResponseBudget();
    if (accountedResponseSpillBytes() + footprint + inheritedBytes > spillByteCap()) {
      spillCounters.writeFailures += 1;
      replaceWithSpillFailure(id, candidate);
      deferSupersededSpill(inheritedSpill);
      return;
    }
  }
  const job: PendingResponseSpill = {
    id,
    candidate,
    ...(inheritedSpill ? { supersededSpill: inheritedSpill } : {}),
    directAdmission: options.directAdmission === true,
    running: false,
    cancelled: false,
    released: false,
    sizeBytes: candidate.sizeBytes,
    reservedBytes: footprint,
    publicationControl: createResponseSpillPublicationControl(),
  };
  pendingResponseSpills.add(job);
  pendingResponseSpillById.set(id, job);
  pendingResponseSpillBytes += job.sizeBytes;
  reservedResponseSpillBytes += job.reservedBytes;
  recomputeOldestResident();
  responseSpillPublicationTail = responseSpillPublicationTail
    .then(() => runPendingResponseSpill(job), () => runPendingResponseSpill(job));
}

function replaceWithPendingResponseSpill(
  id: string,
  candidate: ResidentResponseState,
  expected: StoredResponseState | undefined,
  options: { directAdmission?: boolean } = {},
): boolean {
  const inheritedSpill = pendingResponseSpillById.get(id)?.supersededSpill
    ?? (expected?.kind === "spill" ? expected.spill : undefined);
  if (!replaceMapEntry(id, candidate, expected)) return false;
  queuePendingResponseSpill(id, candidate, {
    ...(inheritedSpill ? { supersededSpill: inheritedSpill } : {}),
    directAdmission: options.directAdmission === true,
  });
  return true;
}

/** Test-only: settle every serialized Windows spill publication. */
export async function flushPendingResponseSpillsForTests(): Promise<void> {
  await drainResponseSpillPublications();
}

/** Test-only: observe ordinary queue settlement without invoking shutdown fallback. */
export async function awaitResponseSpillPublicationTailForTests(): Promise<void> {
  await responseSpillPublicationTail;
}

/** Test-only: observe the bounded queue without exposing payloads. */
export function pendingResponseSpillMetricsForTests(): { count: number; bytes: number } {
  return { count: pendingResponseSpills.size, bytes: pendingResponseSpillBytes };
}

/** Test-only: shorten the shutdown drain/fallback budget (null restores production values). */
export function setResponseSpillShutdownBudgetForTests(
  budget: { totalMs: number; fallbackReserveMs: number } | null,
): void {
  responseSpillShutdownBudgetOverride = budget;
}

/** Test-only: shorten the ordinary async whole-attempt ACL budget. */
export function setResponseSpillAsyncAclAttemptBudgetForTests(budgetMs: number | null): void {
  responseSpillAsyncAclAttemptBudgetOverride = budgetMs;
}

function responseSpillAsyncAclAttemptBudgetMs(): number {
  return responseSpillAsyncAclAttemptBudgetOverride ?? RESPONSE_SPILL_ASYNC_ACL_ATTEMPT_BUDGET_MS;
}

/** Test-only: lower the hard terminalization pass guard (null restores production). */
export function setResponseSpillShutdownTerminalizationPassLimitForTests(limit: number | null): void {
  responseSpillShutdownTerminalizationPassLimitOverride = limit;
}

function responseSpillShutdownTerminalizationPassLimit(): number {
  return responseSpillShutdownTerminalizationPassLimitOverride
    ?? RESPONSE_SPILL_SHUTDOWN_TERMINALIZATION_MAX_PASSES;
}

function responseSpillShutdownBudget(): { totalMs: number; fallbackReserveMs: number } {
  return responseSpillShutdownBudgetOverride ?? {
    totalMs: RESPONSE_SPILL_SHUTDOWN_BUDGET_MS,
    fallbackReserveMs: RESPONSE_SPILL_SHUTDOWN_FALLBACK_RESERVE_MS,
  };
}

function awaitResponseSpillTailUntil(observed: Promise<void>, deadline: number): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve(false);
  return new Promise(resolve => {
    let finished = false;
    const finish = (settled: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(settled);
    };
    const timer = setTimeout(() => finish(false), remaining);
    observed.then(() => finish(true), () => finish(true));
  });
}

function installShutdownFallbackSpill(
  job: PendingResponseSpill,
  candidate: ResidentResponseState,
  aclBudgetMs: number,
): void {
  let ref: ResponseSpillRef | null = null;
  // Supersession released this job's reservation, but the synchronous write below is the
  // largest publication of the shutdown path and has its own link-then-copy fallback
  // holding a temp and a destination at once. Re-reserve for its duration so the cap is
  // not blind exactly where the drain does its heaviest work, and settle in `finally` so
  // every return, throw and mismatch releases it.
  const footprint = publicationFootprintBytes(job.id, candidate);
  reservedResponseSpillBytes += footprint;
  try {
    // Supersession released this job, so its superseded generation is no longer visible
    // to the accounting walk — but the file is still on the volume until
    // `deferSupersededSpill` or a delete takes it. Price it here or the fallback decides
    // against a total short by that whole envelope, which is exactly the gap that lets
    // `debt + footprint <= cap < old + debt + footprint` publish over budget.
    const supersededBytes = job.supersededSpill?.payloadBytes ?? 0;
    // The drain must not publish over the cap either. Reclaim first; if the footprint
    // still does not fit — which is what unreclaimable cleanup debt looks like — the
    // honest close-out is a tombstone, not another file on a volume that is already
    // over budget. `replaceWithSpillFailure` is the same fail-closed ending the budget
    // exhaustion path uses, so replay reports `spill_failed` and the client resends.
    if (accountedResponseSpillBytes() + supersededBytes > spillByteCap()) {
      enforceSpilledResponseBudget();
      if (accountedResponseSpillBytes() + supersededBytes > spillByteCap()) {
        if (states.get(job.id) === candidate) {
          spillCounters.writeFailures += 1;
          replaceWithSpillFailure(job.id, candidate);
          deferSupersededSpill(job.supersededSpill);
        }
        throw Object.assign(new Error("Response spill shutdown fallback exceeds the durable disk cap"), { code: "ENOSPC" });
      }
    }
    ref = writeResponseSpillDurably(job.id, spillPayloadForResident(candidate), { aclBudgetMs });
    if (ref.payloadBytes > responseSpillPayloadCap()) {
      deleteResponseSpill(ref);
      ref = null;
      if (job.directAdmission) admissionCounters.oversizedDrops += 1;
      throw Object.assign(new Error("Response spill payload exceeds replay ceiling"), { code: "EFBIG" });
    }
    if (states.get(job.id) !== candidate) {
      deleteResponseSpill(ref);
      ref = null;
      return;
    }
    if (swapResidentForSpill(job.id, candidate, ref)) {
      ref = null;
      spillCounters.writes += 1;
      if (job.directAdmission) admissionCounters.directSpills += 1;
      deferSupersededSpill(job.supersededSpill);
    }
  } catch (error) {
    if (ref) deleteResponseSpill(ref);
    if (states.get(job.id) === candidate) {
      spillCounters.writeFailures += 1;
      replaceWithSpillFailure(job.id, candidate);
      deferSupersededSpill(job.supersededSpill);
    }
    throw error;
  } finally {
    reservedResponseSpillBytes = Math.max(0, reservedResponseSpillBytes - footprint);
  }
}

function terminalizeShutdownFallbackCandidate(
  job: PendingResponseSpill,
  candidate: ResidentResponseState,
): void {
  if (states.get(job.id) !== candidate) return;
  spillCounters.writeFailures += 1;
  replaceWithSpillFailure(job.id, candidate);
  deferSupersededSpill(job.supersededSpill);
}

function pendingShutdownFallbackCandidates(): Array<{
  job: PendingResponseSpill;
  candidate: ResidentResponseState;
}> {
  return [...pendingResponseSpills]
    .map(job => ({ job, candidate: job.candidate }))
    .filter((entry): entry is { job: PendingResponseSpill; candidate: ResidentResponseState } => !!entry.candidate);
}

function supersedeShutdownFallbackBatch(
  pending: Array<{ job: PendingResponseSpill; candidate: ResidentResponseState }>,
  failures: Error[],
): void {
  for (const { job } of pending) {
    job.cancelled = true;
    markResponseSpillPublicationSuperseded(job.publicationControl);
  }
  for (const { job } of pending) {
    const cleanupFailure = cleanupSupersededResponseSpillPublication(job.publicationControl);
    if (cleanupFailure) {
      failures.push(cleanupFailure);
      // Cleanup failed, so an async temp or destination is STILL on the volume. Releasing
      // the reservation would un-account a file that exists, and the fallback write that
      // follows reserves only its own footprint — three envelopes on disk priced as two.
      //
      // Charge the surviving PATHS rather than a flat two envelopes: `clearOwnedPath`
      // nulls whichever it managed to remove, so one failure is one file, not two. The
      // charge is settled automatically once the path disappears, which a retried unlink
      // or a released Windows lock can still do.
      const perPath = Math.max(1, Math.floor(job.reservedBytes / 2));
      chargeUnreclaimableSpillPath(job.publicationControl.tempPath, perPath);
      chargeUnreclaimableSpillPath(job.publicationControl.destinationPath, perPath);
    }
    releasePendingResponseSpill(job);
  }
}

function stopAtShutdownTerminalizationPassLimit(
  pending: Array<{ job: PendingResponseSpill; candidate: ResidentResponseState }>,
  failures: Error[],
): void {
  failures.push(Object.assign(new Error("Response spill shutdown terminalization pass limit exceeded"), { code: "ELOOP" }));
  supersedeShutdownFallbackBatch(pending, failures);
  for (const { job, candidate } of pending) {
    terminalizeShutdownFallbackCandidate(job, candidate);
  }
  for (const [id, state] of [...states]) {
    if (state.kind !== "resident") continue;
    spillCounters.writeFailures += 1;
    replaceWithSpillFailure(id, state);
  }
  recomputeOldestResident();
  pruneResponses();
  enforceAppOwnedMemoryBudget();
}

function terminalizeExhaustedShutdownFallback(
  initial: Array<{ job: PendingResponseSpill; candidate: ResidentResponseState }>,
  failures: Error[],
): void {
  let pending = initial;
  let passes = 0;
  const passLimit = responseSpillShutdownTerminalizationPassLimit();
  // Every pass replaces each captured resident with a tombstone. Pruning may expose
  // another finite batch, but resident count strictly decreases until none can requeue.
  while (pending.length > 0) {
    if (passes >= passLimit) {
      stopAtShutdownTerminalizationPassLimit(pending, failures);
      return;
    }
    passes += 1;
    supersedeShutdownFallbackBatch(pending, failures);
    for (const { job, candidate } of pending) {
      failures.push(Object.assign(new Error("Response spill shutdown fallback budget exhausted"), { code: "ETIMEDOUT" }));
      terminalizeShutdownFallbackCandidate(job, candidate);
    }
    recomputeOldestResident();
    pruneResponses();
    enforceAppOwnedMemoryBudget();
    pending = pendingShutdownFallbackCandidates();
  }
}

function fallbackPendingResponseSpills(reserveMs: number): Error[] {
  const deadline = Date.now() + reserveMs;
  const failures: Error[] = [];
  for (;;) {
    const pending = pendingShutdownFallbackCandidates();
    if (pending.length === 0) return failures;
    if (Date.now() >= deadline) {
      terminalizeExhaustedShutdownFallback(pending, failures);
      return failures;
    }

    supersedeShutdownFallbackBatch(pending, failures);
    let reserveExhausted = false;
    for (let index = 0; index < pending.length; index += 1) {
      const { job, candidate } = pending[index]!;
      if (states.get(job.id) !== candidate) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reserveExhausted = true;
        for (const exhausted of pending.slice(index)) {
          failures.push(Object.assign(new Error("Response spill shutdown fallback budget exhausted"), { code: "ETIMEDOUT" }));
          terminalizeShutdownFallbackCandidate(exhausted.job, exhausted.candidate);
        }
        break;
      }
      try {
        installShutdownFallbackSpill(job, candidate, remaining);
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error("Response spill shutdown fallback failed"));
      }
    }
    recomputeOldestResident();
    pruneResponses();
    enforceAppOwnedMemoryBudget();
    if (reserveExhausted || Date.now() >= deadline) {
      terminalizeExhaustedShutdownFallback(pendingShutdownFallbackCandidates(), failures);
      return failures;
    }
  }
}

async function drainResponseSpillPublications(): Promise<void> {
  const budget = responseSpillShutdownBudget();
  const fallbackReserveMs = Math.min(budget.totalMs, Math.max(1, budget.fallbackReserveMs));
  const drainDeadline = Date.now() + Math.max(0, budget.totalMs - fallbackReserveMs);

  for (;;) {
    if (pendingResponseSpills.size === 0) return;
    const observed = responseSpillPublicationTail;
    const settled = await awaitResponseSpillTailUntil(observed, drainDeadline);
    if (!settled) {
      const failures = fallbackPendingResponseSpills(fallbackReserveMs);
      if (failures.length > 0) {
        throw new AggregateError(failures, "Response spill shutdown fallback incomplete");
      }
      return;
    }
    if (observed === responseSpillPublicationTail) return;
  }
}

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

let spillByteCapOverride: number | null = null;

function spillByteCap(): number {
  return spillByteCapOverride ?? MAX_SPILLED_RESPONSE_BYTES;
}

/**
 * Live total of durable spill payloads. Recomputed per call rather than carried as
 * a running counter: spilled entries reach `states` through several insertion paths
 * (demotion swap, direct oversized admission, snapshot reload), and one missed
 * increment there would silently disable the cap, where an O(MAX_STORED_RESPONSES)
 * walk cannot drift.
 */
function spilledResponseBytes(): number {
  let total = 0;
  for (const entry of states.values()) {
    if (entry.kind === "spill") total += entry.spill.payloadBytes;
  }
  // Superseded generations awaiting a durable snapshot are still files on disk.
  // Counting only `states` would let PENDING_SPILL_UNLINKS_MAX of them sit outside
  // the budget while it reports itself satisfied.
  for (const ref of pendingSpillUnlinks) total += ref.payloadBytes;
  return total;
}

/**
 * Accounted on-disk bytes: files that exist, plus the peak footprint of publications
 * already in flight.
 *
 * The cap is enforced against this rather than against `spilledResponseBytes()` alone,
 * because a publication that has not finished is still consuming the volume. On Windows
 * the gap between "queued" and "installed" is however long `icacls` takes, and the
 * measured incident this cap answers accumulated 6.8 GiB in 44 minutes.
 */
function accountedResponseSpillBytes(): number {
  // Superseded generations a pending job still owns are files on disk too. A same-id
  // replacement removes the old spill from `states` and hands its ref to the job, so
  // counting only `states` plus `pendingSpillUnlinks` loses it for the whole publication
  // — during a copy fallback that is old generation + new temp + new destination, three
  // envelopes priced as two.
  let ownedBySpillJobs = 0;
  for (const job of pendingResponseSpills) {
    if (job.supersededSpill) ownedBySpillJobs += job.supersededSpill.payloadBytes;
  }
  return spilledResponseBytes() + reservedResponseSpillBytes + ownedBySpillJobs
    + reconcileUnreclaimableSpillPaths();
}

/** Test-only: lower/restore the durable spill cap (null restores the default). */
export function setSpilledResponseByteCapForTests(bytes: number | null): void {
  spillByteCapOverride = bytes;
}

/** Test-only: current durable spill accounting (proves evictions unlink their files). */
export function getSpilledResponseBytesForTests(): number {
  return spilledResponseBytes();
}

/** Test-only: on-disk bytes plus in-flight publication reservations. */
export function getAccountedResponseSpillBytesForTests(): number {
  return accountedResponseSpillBytes();
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
    if (pendingResponseSpillById.get(id)?.candidate === state) continue;
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
  const supersededSpill = cancelPendingResponseSpill(id);
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
  if (options.deleteSpill !== false && supersededSpill) deleteResponseSpill(supersededSpill);
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
  const pending = pendingResponseSpillById.get(id);
  if (windowsSecretAclApplies() && (expected?.kind === "spill" || pending?.supersededSpill)) {
    replaceWithPendingResponseSpill(id, candidate, expected);
    pruneResponses();
    return;
  }
  if (expected?.kind === "spill") {
    replaceSpillEntryAtomically(id, expected, candidate);
    pruneResponses();
    return;
  }
  if (windowsSecretAclApplies()) cancelPendingResponseSpill(id);
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
  if (windowsSecretAclApplies()) {
    replaceWithPendingResponseSpill(id, candidate, expected, { directAdmission: true });
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
      const payload = JSON.stringify({ version: 2, states: entries });
      const payloadBytes = Buffer.byteLength(payload, "utf8");
      const payloadDigest = Bun.hash(payload).toString(36);
      // A mutation does not always change what gets persisted: entries past the
      // per-entry or total byte bound are dropped from the selection, and spill
      // demotion moves bytes out of it. Re-writing a byte-identical 24 MiB file
      // buys nothing, so compare first — but the cached digest describes what THIS
      // process last wrote, which is not the same claim as "that is what is on disk
      // now". A second proxy sharing the home, or anything that rewrites the file
      // in place, leaves the digest describing bytes that are gone. Before every
      // release-of-a-write, the previous behaviour rewrote unconditionally and so
      // repaired that silently; skipping without checking would turn a repaired
      // snapshot into a lost one at the next restart.
      //
      // Verify against the file itself, keyed to the resolved target so a retargeted
      // symlink is also a miss. Reading back a matching-size file costs far less
      // than the atomic replace it avoids, and only happens when the digest already
      // matched — the amplification this fixes is the repeated WRITE, not the read.
      const unchanged = lastSnapshotDigest !== null
        && payloadDigest === lastSnapshotDigest
        && payloadBytes === lastSnapshotBytes
        && lastSnapshotTarget === resolveWriteTarget(path)
        && existsSync(path)
        && await snapshotOnDiskMatches(path, payload, payloadBytes);
      if (!unchanged) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        try { chmodSync(dirname(path), 0o700); } catch { /* best-effort (e.g. Windows) */ }
        await atomicWriteFileAsync(path, payload);
        lastSnapshotDigest = payloadDigest;
        lastSnapshotBytes = payloadBytes;
        lastSnapshotTarget = resolveWriteTarget(path);
      }
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

/**
 * Debounce scaled by the size of the last snapshot written.
 *
 * The whole snapshot is re-serialized and atomically replaced on every flush, so at
 * the 24 MiB bound a fixed 2 s debounce is up to ~12 MB/s of write amplification for
 * state nothing reads until the next start (#2460). Small snapshots keep the base
 * cadence; the stretch is linear in size and clamped, so the write rate is roughly
 * flat instead of growing with the file.
 */
function snapshotDebounceMs(): number {
  if (lastSnapshotBytes <= SNAPSHOT_DEBOUNCE_SCALE_FROM_BYTES) return SNAPSHOT_DEBOUNCE_MS;
  const scaled = Math.round(SNAPSHOT_DEBOUNCE_MS * (lastSnapshotBytes / SNAPSHOT_DEBOUNCE_SCALE_FROM_BYTES));
  return Math.min(scaled, SNAPSHOT_DEBOUNCE_MAX_MS);
}

function schedulePersistAt(path: string, replace = false): void {
  if (persistTimer && !replace) return;
  if (persistTimer) clearTimeout(persistTimer);
  pendingPersistPath = path;
  persistTimer = setTimeout(() => { void persistNow(path); }, snapshotDebounceMs());
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

async function flushResponseSnapshot(): Promise<void> {
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

/** Flush publications and snapshot state; report drain failure only after persistence completes. */
export async function flushResponseState(): Promise<void> {
  const failures: unknown[] = [];
  try {
    await drainResponseSpillPublications();
  } catch (error) {
    failures.push(error);
  }
  try {
    await flushResponseSnapshot();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Response state shutdown flush incomplete");
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

/**
 * Bring the durable spill set inside MAX_SPILLED_RESPONSE_BYTES, and report the
 * bytes released.
 *
 * One owner, three callers: mutation pruning, the lazy load that follows a
 * restart, and the periodic sweep. The periodic caller is not redundant — the
 * mutation path only runs when traffic arrives, and a process can come up over
 * budget from a snapshot written under a larger ceiling and then sit idle. That
 * was observed in production at 1.8 GiB against a 1 GiB cap, held until the first
 * request.
 *
 * NOT covered here: spill files orphaned by a crash. They are absent from
 * `states`, so this function can neither see nor price them, and they stay with
 * recoverOrphanedResponseSpills and its RESPONSE_SPILL_ORPHAN_GRACE_MS window.
 * This ceiling therefore bounds what the store owns, which is every file it can
 * account for, and not the directory as a whole.
 */
function enforceSpilledResponseBudget(): number {
  // Price in-flight publications too: a file being created by
  // `writeResponseSpillDurablyAsync` occupies the volume before it reaches `states`.
  let spilledBytes = accountedResponseSpillBytes();
  if (spilledBytes <= spillByteCap()) return 0;
  const before = spilledBytes;
  // Deferred generations go first. They are already superseded, so releasing one
  // costs only the crash window the queue exists to cover — the same trade
  // PENDING_SPILL_UNLINKS_MAX already makes against unbounded disk. Evicting a
  // live continuation to make room for a dead file would be the wrong order.
  while (spilledBytes > spillByteCap() && pendingSpillUnlinks.length > 0) {
    const ref = pendingSpillUnlinks.shift()!;
    spilledBytes -= ref.payloadBytes;
    deleteResponseSpill(ref);
  }
  // Ordered by createdAt, not by map order. `states` is not an age index:
  // demotion and spill replacement delete and reinsert entries, and
  // writeBoundedSnapshot serializes the map reversed, so map order can put a
  // newer continuation first — and evicting that one spends a resume the older
  // entry would not have cost. Sorting is O(k log k) over the spilled subset and
  // runs only on a tick already over budget.
  const spilled = [...states]
    .filter((pair): pair is [string, SpilledResponseState] => pair[1].kind === "spill")
    // createdAt is millisecond-resolution, so ties are ordinary under load. A
    // stable sort would then fall back to insertion order — the very order this
    // is avoiding — so break ties on the response id. Not localeCompare: the
    // order must not depend on the host locale.
    .sort((a, b) => a[1].createdAt - b[1].createdAt
      || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [id, entry] of spilled) {
    if (spilledBytes <= spillByteCap()) break;
    spilledBytes -= entry.spill.payloadBytes;
    deleteEntry(id);
  }
  return before - spilledBytes;
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
    const oldestResident = [...states].find(([id, entry]) => entry.kind === "resident"
      && pendingResponseSpillById.get(id)?.candidate !== entry);
    const hasPendingResident = !oldestResident && [...states].some(([id, entry]) => entry.kind === "resident"
      && pendingResponseSpillById.get(id)?.candidate === entry);
    if (hasPendingResident) break;
    const oldestId = oldestResident?.[0] ?? states.keys().next().value as string | undefined;
    if (!oldestId) break;
    const entry = states.get(oldestId)!;
    if (entry.kind !== "resident") {
      deleteEntry(oldestId);
      continue;
    }
    if (windowsSecretAclApplies()) {
      queuePendingResponseSpill(oldestId, entry);
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
  enforceSpilledResponseBudget();
}

/** Periodic TTL-only sweep; count/byte eviction remains owned by mutation paths. */
export function sweepExpiredResponseStates(at = now()): number {
  let removed = 0;
  for (const [id, state] of states) {
    if (at - state.createdAt <= RESPONSE_TTL_MS) continue;
    deleteEntry(id);
    removed += 1;
  }
  // The disk ceiling needs a caller that does not depend on traffic. The return
  // value stays the TTL count so this function's existing contract is unchanged.
  const reclaimed = enforceSpilledResponseBudget();
  if (removed > 0 || reclaimed > 0) schedulePersist();
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
  let currentPendingBytes = 0;
  for (const job of pendingResponseSpills) {
    if (job.candidate && states.get(job.id) === job.candidate) currentPendingBytes += job.sizeBytes;
  }
  const detachedPendingBytes = Math.max(0, pendingResponseSpillBytes - currentPendingBytes);
  const bytes = storedResponseBytes + detachedPendingBytes;
  const evictableBytes = Math.max(0, residentResponseBytes - currentPendingBytes);
  return {
    count: states.size,
    bytes,
    evictableBytes,
    pinnedBytes: Math.max(0, bytes - evictableBytes),
    oldestAt: oldestResidentAt,
  };
}

export function evictOldestResponseContinuationForBudget(): number {
  if (oldestResidentId === undefined) return 0;
  const id = oldestResidentId;
  const entry = states.get(id);
  if (!entry || entry.kind !== "resident") return 0;
  if (windowsSecretAclApplies()) {
    queuePendingResponseSpill(id, entry);
    schedulePersist();
    return 0;
  }
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
    totalBytes: responseContinuationRetainedStoreSnapshot().bytes,
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
  for (const id of [...pendingResponseSpillById.keys()]) cancelPendingResponseSpill(id);
  pendingResponseSpillById.clear();
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
  lastSnapshotBytes = 0;
  lastSnapshotDigest = null;
  lastSnapshotTarget = null;
  loaded = false;
}

export function clearResponseStateForTests(): void {
  for (const entry of states.values()) deleteOwnedSpills(entry);
  clearResponseStateMemoryForTests();
  reservedResponseSpillBytes = 0;
  unreclaimableSpillPaths.clear();
  try {
    unlinkSync(snapshotPath());
  } catch {
    /* no snapshot on disk */
  }
  try { rmSync(responseSpillDirectory(), { recursive: true, force: true }); } catch { /* no spill directory */ }
}
