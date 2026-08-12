/**
 * Resolve the transition a history job belongs to.
 *
 * `updateCodexHistoryTransition` had no production caller, so every completed or
 * skipped job left the coordinator row permanently `pending` — a transition was
 * published and never resolved. This is that caller.
 *
 * The classification is `020_history_isolation.md:564-572`, applied rather than
 * reinvented. The two unions do not line up one-to-one, so each outcome is
 * mapped by hand: a cast across them would compile on the words they share and
 * lie about the rest.
 */
import type { CodexHistoryJobOutcome } from "./history-job";
import type { CodexHistoryState, CodexTransitionVersion } from "./convergence-types";
import { updateCodexHistoryTransition } from "./transition-state";

/** The retry budget for a contended terminal CAS. Bounded; never unbounded. */
const TERMINAL_RETRY_ATTEMPTS = 3;
const TERMINAL_RETRY_DELAY_MS = 250;

function sleep(ms: number): void {
  // The caller path here is synchronous after the awaited job, so a spin is the
  // honest tool — awaiting would be, and this is short.
  const until = Date.now() + ms;
  while (Date.now() < until) { /* bounded */ }
}

function classify(outcome: CodexHistoryJobOutcome, txId: string | null): CodexHistoryState {
  switch (outcome.kind) {
    case "converged":
      return {
        status: "converged",
        attempts: 1,
        nextRetryAt: null,
        txId,
        // A zero is durable only when the worker proved the exact DB/manifest
        // state while H was held. Without proof, keep the counts unknown. Keep
        // `??`: `||` would discard a verified zero.
        pendingRows: outcome.proof?.pendingRows ?? null,
        backupEntries: outcome.proof?.backupEntries ?? null,
      };
    case "skipped":
      // The user opting out is a completed decision, not a failure — converged
      // with no reason. Marking it blocked would retry what they asked not to do.
      return { status: "converged", attempts: 0, nextRetryAt: null, txId, pendingRows: null, backupEntries: null };
    case "blocked":
      return {
        status: outcome.reason === "busy" ? "pending" : "blocked",
        reason: outcome.reason === "busy" ? "db-busy"
          : outcome.reason === "database" ? "unreadable"
          : "permission",
        attempts: 1,
        // A busy unit retries; the others do not reschedule themselves.
        nextRetryAt: outcome.reason === "busy"
          ? new Date(Date.now() + TERMINAL_RETRY_DELAY_MS * 10).toISOString()
          : null,
        txId,
        pendingRows: null,
        backupEntries: null,
      };
    case "failed":
      return {
        status: "unknown",
        reason: outcome.reason === "timeout" ? "timeout"
          : outcome.reason === "worker-died" ? "worker-died"
          : "record-write-failed",
        attempts: 1,
        nextRetryAt: null,
        txId,
        pendingRows: null,
        backupEntries: null,
      };
  }
}

/**
 * Publish the terminal state of a history job against the transition it belongs
 * to. A `conflict` means a newer transition won and is deliberately left alone.
 * A `busy` terminal CAS retries a bounded number of times; when that exhausts,
 * the previously persisted `pending` schedule is left intact — the same update
 * needs the lock that was busy, so it cannot record its own failure
 * (`005_contract.md:277`), and the retry being out of attempts is itself a
 * terminal observation.
 */
export function resolveCodexHistoryTransition(
  receipt: CodexTransitionVersion,
  outcome: CodexHistoryJobOutcome,
): void {
  const state = classify(outcome, receipt.currentTxId);
  for (let attempt = 0; attempt < TERMINAL_RETRY_ATTEMPTS; attempt += 1) {
    const result = updateCodexHistoryTransition(receipt, state);
    if (result.kind === "updated") return;
    if (result.kind === "conflict") {
      // A newer transition already owns the row. Overwriting it would be the
      // overtaken job overwriting the winner.
      return;
    }
    if (result.reason === "busy") {
      if (attempt + 1 < TERMINAL_RETRY_ATTEMPTS) sleep(TERMINAL_RETRY_DELAY_MS * (attempt + 1));
      continue;
    }
    // database / unsafe-path: retried CAS will not help.
    return;
  }
}
