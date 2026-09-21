/**
 * Runtime owner for the opt-in usage-ledger size limit (#5063).
 *
 * The compactor in `src/usage/ledger-retention.ts` knows how to publish a smaller ledger safely.
 * This is the part that decides when, and -- the half #5063 was missing -- what has to be
 * discarded afterwards.
 *
 * Deleting rows from usage.jsonl invalidates three readers that do not watch the file: the
 * 2,000-entry Logs ring, which otherwise keeps serving rows the ledger no longer has; the
 * retained usage aggregate and failure projection, whose checkpoints now point past a boundary
 * that moved; and the request-history index, whose source identity has changed. A compaction
 * that skips any of them makes the dashboard disagree with the ledger, which is the disagreement
 * this batch exists to remove.
 */
import { currentUsageLogRevision, setUsageLedgerAppendHook } from "../usage/log";
import { enforceUsageLedgerSizeLimit } from "../usage/ledger-retention";
import { discardRetainedFailureProjection } from "../usage/failure-projection-cache";
import { rehydrateRequestLogsAfterLedgerReplacement } from "./request-log";
import type { UsageLedgerRetentionStatus } from "../usage/retention-contract";

let configuredMaxBytes: number | undefined;
let enforcing = false;

function invalidateLedgerReaders(): void {
  // Ordered cheapest-first, and each guarded on its own: a projection that fails to discard
  // must not stop the ring from being rebuilt, because the ring is the surface an operator is
  // looking at while this happens.
  try { discardRetainedFailureProjection(); } catch { /* rebuildable by construction */ }
  void (async () => {
    try {
      const { discardRetainedUsageAggregate } = await import("./management/usage-aggregate-cache");
      discardRetainedUsageAggregate();
    } catch { /* rebuildable by construction */ }
    try {
      const { closeRequestHistoryIndex } = await import("../routing/history/indexer");
      closeRequestHistoryIndex();
    } catch { /* the index rebuilds from its own source-identity contract */ }
  })();
  try { rehydrateRequestLogsAfterLedgerReplacement(); } catch { /* the ring refills as rows arrive */ }
}

function enforceNow(): void {
  // Re-entrancy guard, not a lock. The compaction itself runs inside the append call stack, and
  // its own publication writes nothing through appendUsageEntry -- this exists so a future
  // caller on that path cannot start a second pass over a file the first one is replacing.
  if (enforcing) return;
  enforcing = true;
  try {
    const result = enforceUsageLedgerSizeLimit(configuredMaxBytes);
    if (result.kind === "replaced") invalidateLedgerReaders();
  } catch (error) {
    // Never fail a request because history could not be trimmed. The limit is not enforced and
    // says so; the next append tries again from a fresh revision.
    console.warn(
      `[usage-retention] could not enforce the usage ledger size limit: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    enforcing = false;
  }
}

/** Install or update the policy. `undefined` removes the hook entirely. */
export function setUsageLedgerRetention(maxBytes: number | undefined): void {
  configuredMaxBytes = maxBytes;
  setUsageLedgerAppendHook(maxBytes === undefined ? null : enforceNow);
}

export function usageLedgerRetentionStatus(): UsageLedgerRetentionStatus {
  return {
    ...(configuredMaxBytes !== undefined ? { maxBytes: configuredMaxBytes } : {}),
    currentBytes: currentUsageLogRevision()?.size ?? 0,
  };
}
