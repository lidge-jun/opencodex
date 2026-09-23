/**
 * Structured summary for `ocx stop --json` (D4 of the app runtime ownership unit).
 *
 * The desktop shell drives the real `ocx stop` as a child process so the receipt-backed
 * teardown, the drain, the Windows respawn verification and the client-config restore run
 * exactly as they do from a terminal. This module makes that run's RESULT readable from
 * outside: a StopRunRecord is threaded through the existing stop path in
 * src/cli/index.ts (the same booleans that already decide the exit code), and
 * summarizeStopRun turns it into one versioned JSON document.
 *
 * Nothing here re-decides anything. If a field of the record is wrong, the fix belongs
 * in the stop path, not in the summarizer.
 */
import { STOP_HISTORY_DEFERRED_EXIT_CODE } from "../update/stop-contract.mjs";

/** Wire version of the stop summary document. */
export const STOP_SUMMARY_SCHEMA = "ocx-stop/1";

export type StopServiceOutcome =
  | "absent"
  | "stopped"
  | "stopped-respawnable"
  | "failed"
  | "state-unknown"
  | "error";

export type StopProxyOutcome =
  | "stopped"
  | "stopped-orphan"
  | "not-running"
  | "stop-failed"
  | "ownership-refused"
  | "unresolvable-pid"
  | "respawned"
  | "unknown";

export type StopSharedTeardownOutcome =
  | "restored"
  | "performed-by-proxy"
  | "refused"
  | "failed"
  | "skipped";

/** Facts recorded where the stop path already decides them. */
export interface StopRunRecord {
  /** What stopServiceIfInstalledDetailed returned, or "error" when it threw. */
  service: StopServiceOutcome;
  /** Which proxy path ran and how it ended. */
  proxy: StopProxyOutcome;
  /** Who ended up restoring shared client config (native Codex + Grok). */
  sharedTeardown: StopSharedTeardownOutcome;
  /** An inherited pending-teardown receipt blocked the restore. */
  inheritedTeardownBlocks: boolean;
  /** A discharged receipt could not be removed from disk. */
  receiptClearFailed: boolean;
}

/** The internal booleans that already pick the process exit code. */
export interface StopRunSignals {
  failed: boolean;
  historyOnly: boolean;
  historyDeferred: boolean;
  exitCode: number;
}

export interface StopSummaryJson {
  schema: typeof STOP_SUMMARY_SCHEMA;
  /** Strict exit-code view: true only for exit 0. */
  ok: boolean;
  outcome: "stopped" | "not-running" | "history-incomplete" | "history-deferred" | "failed";
  exitCode: number;
  /** True when this stop left no proxy of this home running by its own paths. */
  runtimeDown: boolean;
  service: StopServiceOutcome;
  proxy: StopProxyOutcome;
  sharedTeardown: StopSharedTeardownOutcome;
  /** One stable human-readable line for a caller's UI. */
  message: string;
}

/** What handleStop returns: the pre-existing boolean plus the structured twin. */
export interface StopOutcome {
  /**
   * The exact boolean the stop path returned before summaries existed (!stopFailed).
   * It is NOT the same as summary.ok: 79/80 stops return true here, because the
   * downtime warning that keys on it applies whenever the runtime went down.
   */
  ok: boolean;
  summary: StopSummaryJson;
}

function stopOutcome(record: StopRunRecord, signals: StopRunSignals): StopSummaryJson["outcome"] {
  if (signals.failed) return "failed";
  if (signals.historyOnly) return "history-incomplete";
  if (signals.historyDeferred) {
    // The deferred exit code is a proven claim; anything else means another obligation
    // was sitting in the home, which the exit-code logic already reports as failure.
    return signals.exitCode === STOP_HISTORY_DEFERRED_EXIT_CODE ? "history-deferred" : "failed";
  }
  if (record.proxy === "not-running") return "not-running";
  if (record.proxy === "stopped" || record.proxy === "stopped-orphan") return "stopped";
  return "failed";
}

function stopMessage(record: StopRunRecord, signals: StopRunSignals, outcome: StopSummaryJson["outcome"]): string {
  if (record.proxy === "respawned") return "The proxy was respawned after the stop; it is still running.";
  if (record.proxy === "ownership-refused") return "The proxy refused the stop; it belongs to a different opencodex home.";
  if (record.proxy === "unresolvable-pid") return "A proxy is answering, but its process id could not be resolved, so it was not stopped.";
  if (record.proxy === "stop-failed") return "The proxy process could not be stopped.";
  if (record.service === "failed") return "The installed service manager did not stop and may respawn the proxy.";
  if (record.service === "state-unknown") return "The service manager state could not be read.";
  if (record.service === "error") return "Stopping the installed service failed.";
  if (record.inheritedTeardownBlocks) return "An earlier stop left an outstanding shared teardown that could not be confirmed.";
  if (record.sharedTeardown === "failed") return "The shared teardown failed; client configuration may still point at the stopped proxy.";
  if (record.receiptClearFailed) return "The shared teardown finished, but its receipt could not be removed.";
  if (record.sharedTeardown === "refused") return "The shared teardown was refused before it changed anything; it is still owed.";
  if (signals.historyOnly) return "The proxy stopped; Codex history cleanup did not complete.";
  if (outcome === "history-deferred") return "The proxy stopped; the shared teardown was deferred and is still owed.";
  if (outcome === "not-running") return "No proxy was running.";
  if (outcome === "stopped") return "The proxy stopped.";
  return "The stop failed.";
}

/** Pure mapper from the recorded run to the wire document. */
export function summarizeStopRun(record: StopRunRecord, signals: StopRunSignals): StopSummaryJson {
  const outcome = stopOutcome(record, signals);
  return {
    schema: STOP_SUMMARY_SCHEMA,
    ok: signals.exitCode === 0,
    outcome,
    exitCode: signals.exitCode,
    runtimeDown: record.proxy === "stopped" || record.proxy === "stopped-orphan" || record.proxy === "not-running",
    service: record.service,
    proxy: record.proxy,
    sharedTeardown: record.sharedTeardown,
    message: stopMessage(record, signals, outcome),
  };
}

/** Emit the summary as exactly one JSON document on stdout. */
export function printStopSummary(summary: StopSummaryJson, stdout: { log: (s: string) => void } = console): void {
  stdout.log(JSON.stringify(summary));
}
