/**
 * Worker-thread entry for the Codex history unit.
 *
 * Everything mutable about history happens here, behind H: the SQLite rows, the
 * backup manifest, and every rollout patch. Those three do not share a
 * transaction — sync writes the manifest before its database transaction, and
 * restore writes rollouts, then the database, then the manifest
 * (`src/codex/history-provider.ts:606-648,656-698`) — so a busy timeout only
 * ever serialized a third of a state transition. Holding H across the whole unit
 * is what stops an opposite-direction process overtaking through the other two.
 *
 * The message is deliberately thin, and it does NOT carry a direction. A caller
 * saying which way history should move is exactly what the durable operation
 * exists to prevent: `syncResumeHistory: false` means leave history alone, apply
 * targets opencodex only in legacy mode, and legacy recovery is a different
 * operation from generic restore. So the Worker is told which JOB to run and
 * reads the operation from the coordinator row itself.
 *
 * Homes are carried explicitly because a Worker is a separate process: it does
 * not inherit the module-load `CODEX_HOME` that `history-provider.ts` resolves
 * at import time, so a request that leaned on those constants would silently
 * address the wrong home.
 *
 * Design record: devlog/_fin/260804_codex_write_substrate/020_history_isolation.md.
 */
import { withHistoryWriteSerialization } from "./history-lock";
import { loadConfig } from "../config";
import { shouldSyncCodexOnStart } from "./desired-state";
import {
  writeHistoryProviderTransition,
  writeLegacyOpenaiHistoryRecovery,
  type HistoryWriteTarget,
} from "./internal/history-writer";
import {
  snapshotCodexHistoryNoop,
  type CodexHistoryFailureReason,
  type CodexHistoryVerifiedNoopProof,
} from "./history-provider";

/**
 * The durable operation, mirrored into the request for diagnostics only.
 *
 * The Worker validates this against what it reads and refuses a mismatch rather
 * than trusting it — a tampered copy must not be able to turn a restore into an
 * apply. Structured-clone safe by construction: a closed set of string literals.
 */
export type CodexHistoryWorkerOperation =
  | "skip"
  | "apply-opencodex"
  | "migrate-openai"
  | "restore-openai"
  | "recover-legacy-openai";

export interface HistoryWorkerRunMessage {
  readonly type: "run";
  readonly requestId: string;
  /** Opaque durable job identity; the Worker refuses work that is not current. */
  readonly jobId: string;
  readonly operation: CodexHistoryWorkerOperation;
  readonly canonicalCodexHome: string;
  readonly canonicalStateDbPath: string;
  readonly canonicalBackupPath: string;
  /** When set, prove this transition's desired direction while H is held. */
  readonly expectedDesiredEnabled?: boolean;
  /** Env snapshot: a Worker may not observe parent mutations on every platform. */
  readonly env?: { readonly CODEX_HOME?: string; readonly OPENCODEX_HOME?: string };
}

export type HistoryWorkerResult =
  | { readonly type: "done"; readonly requestId: string; readonly jobId: string;
      readonly outcome: "converged" | "skipped";
      readonly rows: number; readonly files: number;
      readonly proof?: CodexHistoryVerifiedNoopProof }
  | { readonly type: "blocked"; readonly requestId: string; readonly jobId: string;
      readonly reason: "busy" | "database" | "unsafe-path" | "desired_disabled" | "desired_enabled" }
  | { readonly type: "error"; readonly requestId: string; readonly jobId: string;
      readonly message: string; readonly reason?: CodexHistoryFailureReason };

const OPERATIONS: ReadonlySet<string> = new Set<CodexHistoryWorkerOperation>([
  "skip",
  "apply-opencodex",
  "migrate-openai",
  "restore-openai",
  "recover-legacy-openai",
]);

/**
 * Validate the message before it can reach a writer.
 *
 * A malformed message is dropped rather than coerced. Every field is required
 * and non-empty: an absent path would otherwise fall back to a module-load
 * constant that points at the wrong home in this process.
 */
export function isHistoryWorkerRunMessage(data: unknown): data is HistoryWorkerRunMessage {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const message = data as Record<string, unknown>;
  const nonEmpty = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  return message.type === "run"
    && nonEmpty(message.requestId)
    && nonEmpty(message.jobId)
    && typeof message.operation === "string"
    && OPERATIONS.has(message.operation)
    && nonEmpty(message.canonicalCodexHome)
    && nonEmpty(message.canonicalStateDbPath)
    && nonEmpty(message.canonicalBackupPath)
    && (message.expectedDesiredEnabled === undefined || typeof message.expectedDesiredEnabled === "boolean");
}

/**
 * Run one history operation under H.
 *
 * Exported so the unit can be exercised in-process; the Worker entry below is a
 * thin adapter over it. `skip` is a real outcome rather than an absence: opting
 * out of history resume must be recorded, not inferred from nothing happening.
 */
export function runHistoryUnitUnderLock(
  message: HistoryWorkerRunMessage,
): HistoryWorkerResult {
  const { requestId, jobId, operation } = message;
  const target: HistoryWriteTarget = {
    canonicalStateDbPath: message.canonicalStateDbPath,
    canonicalBackupPath: message.canonicalBackupPath,
  };

  if (operation === "skip") {
    return { type: "done", requestId, jobId, outcome: "skipped", rows: 0, files: 0 };
  }

  const acquired = withHistoryWriteSerialization(
    message.canonicalCodexHome,
    message.canonicalStateDbPath,
    permit => {
      if (message.expectedDesiredEnabled !== undefined
        && shouldSyncCodexOnStart(loadConfig()) !== message.expectedDesiredEnabled) {
        return { desiredStateChanged: true as const };
      }
      if (operation === "recover-legacy-openai") {
        return writeLegacyOpenaiHistoryRecovery(permit, target);
      }
      if (operation === "migrate-openai") {
        const proof = snapshotCodexHistoryNoop(message.canonicalStateDbPath, message.canonicalBackupPath);
        if (proof.kind === "verified-noop") return { verifiedNoop: proof } as const;
      }
      // apply-opencodex routes history to opencodex; migrate/restore return it to
      // native. The provider is derived from the operation, never from a caller.
      const provider = operation === "apply-opencodex" ? "opencodex" : "openai";
      return writeHistoryProviderTransition(permit, target, provider);
    },
  );

  if (acquired.kind !== "completed") {
    return { type: "blocked", requestId, jobId, reason: acquired.reason };
  }
  const result = acquired.value;
  if ("desiredStateChanged" in result) {
    return {
      type: "blocked",
      requestId,
      jobId,
      reason: message.expectedDesiredEnabled ? "desired_disabled" : "desired_enabled",
    };
  }
  if ("verifiedNoop" in result) {
    return {
      type: "done",
      requestId,
      jobId,
      outcome: "converged",
      rows: 0,
      files: 0,
      proof: result.verifiedNoop,
    };
  }
  if (result.failed === true) {
    return {
      type: "error",
      requestId,
      jobId,
      message: "history_transition_failed",
      ...(result.failureReason ? { reason: result.failureReason } : {}),
    };
  }
  return {
    type: "done",
    requestId,
    jobId,
    outcome: "converged",
    rows: result.rows,
    files: result.files,
  };
}

declare const self: Worker;

// Guarded so the module can be imported directly by tests without a Worker host.
if (typeof self !== "undefined" && typeof (self as { onmessage?: unknown }) === "object") {
  self.onmessage = (event: MessageEvent<unknown>) => {
    if (!isHistoryWorkerRunMessage(event.data)) return;
    const message = event.data;
    try {
      if (message.env?.CODEX_HOME) process.env.CODEX_HOME = message.env.CODEX_HOME;
      if (message.env?.OPENCODEX_HOME) process.env.OPENCODEX_HOME = message.env.OPENCODEX_HOME;
      self.postMessage(runHistoryUnitUnderLock(message));
    } catch (error) {
      self.postMessage({
        type: "error",
        requestId: message.requestId,
        jobId: message.jobId,
        message: error instanceof Error ? error.message : "history_worker_failed",
      } satisfies HistoryWorkerResult);
    } finally {
      // Close from inside the Worker so the thread begins exiting before the
      // parent's terminate() races isolate realm reclaim on Windows.
      try {
        (self as unknown as { close?: () => void }).close?.();
      } catch { /* already closing */ }
    }
  };
}
