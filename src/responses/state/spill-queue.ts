import { existsSync } from "node:fs";
import {
  cleanupSupersededResponseSpillPublication,
  createResponseSpillPublicationControl,
  deleteResponseSpill,
  markResponseSpillPublicationSuperseded,
  MAX_RESPONSE_SPILL_PAYLOAD_BYTES,
  prospectiveResponseSpillBytes,
  responseSpillPayloadCap,
  type ResponseSpillPublicationControl,
  type ResponseSpillRef,
  writeResponseSpillDurably,
  writeResponseSpillDurablyAsync,
} from "../spill-store";
import { enforceAppOwnedMemoryBudget } from "../../lib/app-owned-memory";
import {
  admissionCounters,
  noteSpillWriteFailure,
  noteSpillWriteSuccess,
  spillAclMemoRefusalOrigin,
  type ResponseSpillWriteFailureCode,
  type ResponseSpillWriteFailureOrigin,
} from "./spill-failure";
import type { ResidentResponseState, StoredResponseState } from "../state";

const RESPONSE_SPILL_SHUTDOWN_BUDGET_MS = 5_000;
const RESPONSE_SPILL_SHUTDOWN_FALLBACK_RESERVE_MS = 4_000;
const RESPONSE_SPILL_ASYNC_ACL_ATTEMPT_BUDGET_MS = 30_000;

export interface SpillQueueStore {
  swapResidentForSpill(id: string, expected: ResidentResponseState, ref: ResponseSpillRef): boolean;
  replaceWithSpillFailure(id: string, expected?: StoredResponseState, options?: { deferSpillUnlink?: boolean }): void;
  deleteEntry(id: string, options?: { deleteSpill?: boolean }): void;
  deferSupersededSpill(ref: ResponseSpillRef | undefined): void;
  replaceMapEntry(id: string, next: StoredResponseState, expected?: StoredResponseState): boolean;
  currentEntry(id: string): StoredResponseState | undefined;
  residentEntries(): Array<[string, StoredResponseState]>;
  recomputeOldestResident(): void;
  schedulePersist(): void;
  pruneResponses(): void;
  accountedResponseSpillBytes(): number;
  spillByteCap(): number;
  enforceSpilledResponseBudget(): number;
  terminalizationMaxPasses(): number;
}

let store: SpillQueueStore | null = null;

export function bindSpillQueueStore(next: SpillQueueStore): void {
  store = next;
}

function requireStore(): SpillQueueStore {
  if (!store) throw new Error("spill-queue store is not bound");
  return store;
}

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

function releasePendingResponseSpill(job: PendingResponseSpill): void {
  if (job.released) return;
  job.released = true;
  pendingResponseSpillBytes = Math.max(0, pendingResponseSpillBytes - job.sizeBytes);
  reservedResponseSpillBytes = Math.max(0, reservedResponseSpillBytes - job.reservedBytes);
  pendingResponseSpills.delete(job);
  if (pendingResponseSpillById.get(job.id) === job) pendingResponseSpillById.delete(job.id);
  job.candidate = null;
}

export function cancelPendingResponseSpill(id: string): ResponseSpillRef | undefined {
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
  let exhaustedAclRetry = false;
  let aclRetryFailureOrigin: ResponseSpillWriteFailureOrigin | null = null;
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
      try {
        ref = await writeResponseSpillDurablyAsync(job.id, state, {
          aclBudgetMs: responseSpillAsyncAclAttemptBudgetMs(),
          retryTimedOutOnce: true,
          publicationControl: job.publicationControl,
        });
      } catch (retryError) {
        exhaustedAclRetry = isAclTimeout(retryError);
        // A returned timeout can also mean an exhausted budget before the next OS command.
        aclRetryFailureOrigin = spillAclMemoRefusalOrigin(retryError)
          ?? (exhaustedAclRetry ? "retry_returned_timeout" : null);
        throw retryError;
      }
    }
    if (ref.payloadBytes > responseSpillPayloadCap()) {
      deleteResponseSpill(ref);
      ref = null;
      if (job.directAdmission) admissionCounters.oversizedDrops += 1;
      throw Object.assign(new Error("Response spill payload exceeds replay ceiling"), { code: "EFBIG" });
    }
    if (requireStore().currentEntry(job.id) !== candidate || job.cancelled) {
      deleteResponseSpill(ref);
      ref = null;
      return;
    }
    if (requireStore().swapResidentForSpill(job.id, candidate, ref)) {
      ref = null;
      noteSpillWriteSuccess();
      if (job.directAdmission) admissionCounters.directSpills += 1;
      requireStore().deferSupersededSpill(job.supersededSpill);
    }
  } catch (error) {
    if (ref) deleteResponseSpill(ref);
    if (requireStore().currentEntry(job.id) === candidate && !job.cancelled) {
      noteSpillWriteFailure(error, exhaustedAclRetry ? "EACLRETRYEXHAUSTED" : undefined, aclRetryFailureOrigin);
      requireStore().replaceWithSpillFailure(job.id, candidate);
      requireStore().deferSupersededSpill(job.supersededSpill);
    }
  } finally {
    const cancelled = job.cancelled;
    releasePendingResponseSpill(job);
    requireStore().recomputeOldestResident();
    if (!cancelled) {
      requireStore().schedulePersist();
      requireStore().pruneResponses();
      enforceAppOwnedMemoryBudget();
    }
  }
}

export function queuePendingResponseSpill(
  id: string,
  candidate: ResidentResponseState,
  options: { supersededSpill?: ResponseSpillRef; directAdmission?: boolean } = {},
): void {
  const inheritedSpill = cancelPendingResponseSpill(id) ?? options.supersededSpill;
  if (pendingResponseSpillBytes + candidate.sizeBytes > MAX_PENDING_RESPONSE_SPILL_BYTES) {
    noteSpillWriteFailure(null, "ECAPACITY");
    requireStore().replaceWithSpillFailure(id, candidate);
    requireStore().deferSupersededSpill(inheritedSpill);
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
  if (requireStore().accountedResponseSpillBytes() + footprint + inheritedBytes > requireStore().spillByteCap()) {
    requireStore().enforceSpilledResponseBudget();
    if (requireStore().accountedResponseSpillBytes() + footprint + inheritedBytes > requireStore().spillByteCap()) {
      noteSpillWriteFailure(null, "ECAPACITY");
      requireStore().replaceWithSpillFailure(id, candidate);
      requireStore().deferSupersededSpill(inheritedSpill);
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
  requireStore().recomputeOldestResident();
  responseSpillPublicationTail = responseSpillPublicationTail
    .then(() => runPendingResponseSpill(job), () => runPendingResponseSpill(job));
}

export function replaceWithPendingResponseSpill(
  id: string,
  candidate: ResidentResponseState,
  expected: StoredResponseState | undefined,
  options: { directAdmission?: boolean } = {},
): boolean {
  const inheritedSpill = pendingResponseSpillById.get(id)?.supersededSpill
    ?? (expected?.kind === "spill" ? expected.spill : undefined);
  if (!requireStore().replaceMapEntry(id, candidate, expected)) return false;
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
    ?? requireStore().terminalizationMaxPasses();
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
    if (requireStore().accountedResponseSpillBytes() + supersededBytes > requireStore().spillByteCap()) {
      requireStore().enforceSpilledResponseBudget();
      if (requireStore().accountedResponseSpillBytes() + supersededBytes > requireStore().spillByteCap()) {
        if (requireStore().currentEntry(job.id) === candidate) {
          noteSpillWriteFailure(null, "ECAPACITY");
          requireStore().replaceWithSpillFailure(job.id, candidate);
          requireStore().deferSupersededSpill(job.supersededSpill);
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
    if (requireStore().currentEntry(job.id) !== candidate) {
      deleteResponseSpill(ref);
      ref = null;
      return;
    }
    if (requireStore().swapResidentForSpill(job.id, candidate, ref)) {
      ref = null;
      noteSpillWriteSuccess();
      if (job.directAdmission) admissionCounters.directSpills += 1;
      requireStore().deferSupersededSpill(job.supersededSpill);
    }
  } catch (error) {
    if (ref) deleteResponseSpill(ref);
    if (requireStore().currentEntry(job.id) === candidate) {
      noteSpillWriteFailure(error);
      requireStore().replaceWithSpillFailure(job.id, candidate);
      requireStore().deferSupersededSpill(job.supersededSpill);
    }
    throw error;
  } finally {
    reservedResponseSpillBytes = Math.max(0, reservedResponseSpillBytes - footprint);
  }
}

function terminalizeShutdownFallbackCandidate(
  job: PendingResponseSpill,
  candidate: ResidentResponseState,
  failureCode: ResponseSpillWriteFailureCode = "ETIMEDOUT",
): void {
  if (requireStore().currentEntry(job.id) !== candidate) return;
  noteSpillWriteFailure(null, failureCode);
  requireStore().replaceWithSpillFailure(job.id, candidate);
  requireStore().deferSupersededSpill(job.supersededSpill);
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
    terminalizeShutdownFallbackCandidate(job, candidate, "ELOOP");
  }
  for (const [id, state] of requireStore().residentEntries()) {
    if (state.kind !== "resident") continue;
    noteSpillWriteFailure(null, "ELOOP");
    requireStore().replaceWithSpillFailure(id, state);
  }
  requireStore().recomputeOldestResident();
  requireStore().pruneResponses();
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
    requireStore().recomputeOldestResident();
    requireStore().pruneResponses();
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
      if (requireStore().currentEntry(job.id) !== candidate) continue;
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
    requireStore().recomputeOldestResident();
    requireStore().pruneResponses();
    enforceAppOwnedMemoryBudget();
    if (reserveExhausted || Date.now() >= deadline) {
      terminalizeExhaustedShutdownFallback(pendingShutdownFallbackCandidates(), failures);
      return failures;
    }
  }
}

export async function drainResponseSpillPublications(): Promise<void> {
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

/**
 * Byte accounting the facade's `accountedResponseSpillBytes` adds on top of the
 * installed-spill walk: reserved publication footprint, files a pending job still
 * owns through its superseded generation, and per-path cleanup debt that still
 * exists on the volume.
 */
export function spillQueueAccounting(): { reservedBytes: number; jobOwnedBytes: number; unreclaimableBytes: number } {
  let jobOwnedBytes = 0;
  for (const job of pendingResponseSpills) {
    if (job.supersededSpill) jobOwnedBytes += job.supersededSpill.payloadBytes;
  }
  return {
    reservedBytes: reservedResponseSpillBytes,
    jobOwnedBytes,
    unreclaimableBytes: reconcileUnreclaimableSpillPaths(),
  };
}

/** Resident candidates still owned by queued publications, for facade-side accounting. */
export function spillQueueResidentCandidates(): Array<{ id: string; candidate: ResidentResponseState; sizeBytes: number }> {
  const candidates: Array<{ id: string; candidate: ResidentResponseState; sizeBytes: number }> = [];
  for (const job of pendingResponseSpills) {
    if (job.candidate) candidates.push({ id: job.id, candidate: job.candidate, sizeBytes: job.sizeBytes });
  }
  return candidates;
}

/** Bytes pinned by queued jobs themselves (not their superseded generations). */
export function spillQueuePendingBytes(): number {
  return pendingResponseSpillBytes;
}

/** True when this resident entry is the candidate a queued publication will install. */
export function spillQueueHoldsResidentCandidate(id: string, state: ResidentResponseState): boolean {
  return pendingResponseSpillById.get(id)?.candidate === state;
}

/** Superseded generation a queued job will replace, if one is already parked on it. */
export function spillQueueSupersededSpillFor(id: string): ResponseSpillRef | undefined {
  return pendingResponseSpillById.get(id)?.supersededSpill;
}

/** Test-only: release queued jobs and zero the queue-owned byte accounting. */
export function resetSpillQueueForTests(): void {
  for (const id of [...pendingResponseSpillById.keys()]) cancelPendingResponseSpill(id);
  pendingResponseSpillById.clear();
  reservedResponseSpillBytes = 0;
  unreclaimableSpillPaths.clear();
}
