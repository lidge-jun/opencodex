/**
 * The scan owner for the failure projection: one checkpointed pass over usage.jsonl.
 *
 * Shaped after `src/server/management/usage-aggregate-cache.ts`, which solved the same problem
 * for the usage summary. That similarity is deliberate -- the correctness here is entirely in
 * the checkpoint discipline, and two subtly different versions of it is how a projection quietly
 * extends stale groups across a file that was replaced under it.
 *
 * Every bound this projection obeys belongs to the scanner it calls, not to itself: the 1 MiB
 * row ceiling, the 1 MiB chunk, the cooperative yield, the opened-EOF snapshot boundary and the
 * path/device/inode/birthtime identity with its 64 KiB boundary digest. A projection with its
 * own limits would be a second storage policy, which is what this lane exists to avoid.
 */
import {
  currentUsageLogRevision,
  usageLogIdentityKey,
  usageLogRevisionKey,
  type UsageLogRevision,
} from "./log";
import {
  scanUsageLedgerCooperatively,
  UsageLedgerRebuildRequiredError,
} from "./ledger-scanner";
import {
  createFailureProjectionAccumulator,
  type FailureProjectionAccumulator,
  type FailureProjectionSnapshot,
} from "./failure-projection";

export type FailureProjectionUpdate = "unchanged" | "append" | "rebuild";

export interface FailureProjectionResult extends FailureProjectionSnapshot {
  update: FailureProjectionUpdate;
  /** True once any row was skipped for exceeding the scanner's row ceiling. Sticky. */
  historyIncomplete: boolean;
}

interface RetainedProjection {
  accumulator: FailureProjectionAccumulator;
  historyIncomplete: boolean;
  revision: UsageLogRevision | null;
  identityKey: string;
  revisionKey: string;
  processedThroughBytes: number;
  processedThroughDigest: string;
}

const MAX_REBUILD_ATTEMPTS = 2;
let retained: RetainedProjection | null = null;
let inFlight: Promise<FailureProjectionResult> | null = null;

function resultFrom(state: RetainedProjection, update: FailureProjectionUpdate): FailureProjectionResult {
  return { ...state.accumulator.snapshot(), update, historyIncomplete: state.historyIncomplete };
}

function retain(
  accumulator: FailureProjectionAccumulator,
  scan: Awaited<ReturnType<typeof scanUsageLedgerCooperatively>>,
  historyIncomplete: boolean,
): RetainedProjection {
  return {
    accumulator,
    historyIncomplete: historyIncomplete || scan.oversizedRows > 0,
    revision: scan.revision,
    identityKey: usageLogIdentityKey(scan.revision),
    revisionKey: usageLogRevisionKey(scan.revision),
    processedThroughBytes: scan.processedThroughBytes,
    processedThroughDigest: scan.processedThroughDigest,
  };
}

async function rebuild(signal: AbortSignal | undefined): Promise<FailureProjectionResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_REBUILD_ATTEMPTS; attempt += 1) {
    const accumulator = createFailureProjectionAccumulator();
    try {
      const scan = await scanUsageLedgerCooperatively({
        ...(signal ? { signal } : {}),
        onEntry: entry => accumulator.add(entry),
      });
      retained = retain(accumulator, scan, false);
      return resultFrom(retained, "rebuild");
    } catch (error) {
      lastError = error;
      if (!(error instanceof UsageLedgerRebuildRequiredError) || attempt + 1 >= MAX_REBUILD_ATTEMPTS) throw error;
    }
  }
  throw lastError ?? new Error("failure projection rebuild did not settle");
}

/**
 * Whether the observed ledger can still be read as an append onto the retained state.
 *
 * A same-size file whose revision metadata moved is a replacement or an in-place edit, not an
 * append. Treating it as one would extend groups built from rows that no longer exist, so it
 * forces a rebuild even though the byte count is unchanged.
 */
function requiresRebuild(state: RetainedProjection, observed: UsageLogRevision | null): boolean {
  if (state.identityKey !== usageLogIdentityKey(observed)) return true;
  if (!state.revision || !observed) return state.revision !== observed;
  if (observed.size < state.revision.size) return true;
  return observed.size === state.revision.size && usageLogRevisionKey(observed) !== state.revisionKey;
}

async function append(
  state: RetainedProjection,
  signal: AbortSignal | undefined,
): Promise<FailureProjectionResult> {
  // Clone first and publish only after the scanner verifies the captured suffix, so a mutation
  // discovered mid-scan leaves the retained state exactly as it was.
  const candidate = state.accumulator.clone();
  try {
    const scan = await scanUsageLedgerCooperatively({
      ...(signal ? { signal } : {}),
      startAtBytes: state.processedThroughBytes,
      expectedIdentityKey: state.identityKey,
      expectedProcessedThroughDigest: state.processedThroughDigest,
      onEntry: entry => candidate.add(entry),
    });
    retained = retain(candidate, scan, state.historyIncomplete);
    return resultFrom(retained, "append");
  } catch (error) {
    if (retained === state) retained = null;
    if (error instanceof UsageLedgerRebuildRequiredError) return rebuild(signal);
    throw error;
  }
}

async function refresh(signal: AbortSignal | undefined): Promise<FailureProjectionResult> {
  const state = retained;
  if (!state) return rebuild(signal);
  const observed = currentUsageLogRevision();
  if (requiresRebuild(state, observed)) return rebuild(signal);
  if (observed && state.revision && observed.size === state.revision.size) {
    return resultFrom(state, "unchanged");
  }
  return append(state, signal);
}

/**
 * The current grouping, refreshed from the ledger.
 *
 * Single-flighted: two concurrent readers would otherwise run two scans of the same file and
 * one of them would publish over the other's checkpoint.
 */
export async function getFailureProjection(
  options: { signal?: AbortSignal } = {},
): Promise<FailureProjectionResult> {
  if (inFlight) return inFlight;
  const flight = refresh(options.signal).finally(() => {
    if (inFlight === flight) inFlight = null;
  });
  inFlight = flight;
  return flight;
}

/**
 * Drop the retained projection.
 *
 * Safe at any time and for any reason: it is rebuildable from the ledger by construction, which
 * is the property that lets memory pressure discard the whole thing rather than prune individual
 * groups. Pruning groups would make this projection a retention policy of its own.
 */
export function discardRetainedFailureProjection(): number {
  const count = retained?.accumulator.groupCount ?? 0;
  retained = null;
  return count;
}

/** Test-only process-state reset for isolated harnesses. */
export function resetFailureProjectionCacheForTests(): void {
  retained = null;
  inFlight = null;
}
