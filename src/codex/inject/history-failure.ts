import { describeHistoryJobFailure, type CodexHistoryJobOutcome } from "../history-job";

/**
 * Frame one failed apply history job honestly.
 *
 * A genuine lock keeps the established deferred/SKIPPED wording; any other
 * reason names itself instead of blaming the Codex app/IDE.
 */
export function formatApplyHistoryFailure(outcome: CodexHistoryJobOutcome, legacyMode: boolean): string {
  // A busy database is a deferral no matter which half observed it: the lock
  // contended (blocked/busy), or the worker acquired the lock and then found
  // SQLite busy (failed with a busy history reason). Only those keep the
  // deferred headline; every other failure is a real "NOT changed".
  const busy =
    (outcome.kind === "blocked" && outcome.reason === "busy") ||
    (outcome.kind === "failed" && outcome.historyFailureReason === "busy");
  const partiallyChanged = outcome.kind === "failed"
    && ((outcome.rows ?? 0) > 0 || (outcome.files ?? 0) > 0);
  const headline = partiallyChanged
    ? "Codex resume history changed but did not converge"
    : legacyMode
      ? "Codex resume history sync SKIPPED"
      : busy
      ? "Codex resume history metadata restore deferred"
      : "Codex resume history NOT changed";
  return `  ⚠️ ${headline}: ${describeHistoryJobFailure(outcome, "apply", legacyMode)}\n`;
}
