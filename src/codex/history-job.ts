/**
 * The parent half of the history unit: derive the operation, dispatch the
 * Worker, and never let its failure become the caller's stall.
 *
 * The operation is DERIVED here from what the caller already decided — its
 * config and the direction its native mutation just took — and then handed down
 * as a fixed value. It is not a request field the Worker trusts, because the
 * distinctions are real: `syncResumeHistory: false` means leave history alone,
 * apply targets opencodex only in legacy mode, and legacy recovery must not
 * touch the manifest that generic restore consumes.
 *
 * Every exit is typed. A Worker that errors, dies, or overruns its watchdog
 * produces an outcome the caller can record, because the alternative — an
 * exception crossing back into a route that already persisted its mutation — is
 * how a successful change gets reported as a 500.
 *
 * Design record: devlog/_fin/260804_codex_write_substrate/020_history_isolation.md.
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import type {
  CodexHistoryWorkerOperation,
  HistoryWorkerResult,
} from "./history-worker";
import { historyBackupPathFor } from "./history-provider";
import type { CodexHistoryFailureReason, CodexHistoryVerifiedNoopProof } from "./history-provider";
import { getCodexHome, resolveCodexStateDbPath } from "./paths";

/**
 * Resolve the paths a history job needs, at CALL time.
 *
 * The SQLite root can differ from CODEX_HOME and both environment/config inputs
 * can change between invocations. The parent resolves one exact target and hands
 * those canonical paths to the Worker rather than asking the Worker to infer a
 * possibly different environment.
 */
export function resolveCodexHistoryJobTarget(): {
  readonly canonicalCodexHome: string;
  readonly canonicalStateDbPath: string;
  readonly canonicalBackupPath: string;
} {
  const home = getCodexHome();
  const stateDb = resolveCodexStateDbPath({ codexHome: home });
  return {
    canonicalCodexHome: home,
    canonicalStateDbPath: stateDb,
    // Derived by the provider's own rule rather than guessed: the manifest lives
    // in the config directory under a hash of the state database, so a
    // hand-built path would address a different file entirely.
    canonicalBackupPath: historyBackupPathFor(stateDb),
  };
}

/** How long a history unit may run before the parent stops waiting on it. */
const WORKER_TIMEOUT_MS = 30_000;
/** A terminated Worker must close before its caller can cross the file boundary. */
const WORKER_CLOSE_TIMEOUT_MS = 5_000;

function historyWorkerOsJoinSettleMs(platform = process.platform): number {
  if (platform === "win32") return 1_500;
  if (platform === "darwin" || platform === "linux") return 250;
  return 0;
}

async function terminateAndJoinHistoryWorker(
  worker: Worker,
  closed: Promise<void>,
): Promise<boolean> {
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const closeTimeout = new Promise<void>(resolve => {
    timeout = setTimeout(() => {
      timedOut = true;
      resolve();
    }, WORKER_CLOSE_TIMEOUT_MS);
  });

  try {
    worker.terminate();
  } catch {
    // A Worker that already closed still resolves through the close listener.
  }

  try {
    await Promise.race([closed, closeTimeout]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  const settleMs = historyWorkerOsJoinSettleMs();
  if (settleMs > 0) {
    await Bun.sleep(0);
    await Bun.sleep(settleMs);
  }
  return !timedOut;
}

export interface CodexHistoryJobRequest {
  readonly canonicalCodexHome: string;
  readonly canonicalStateDbPath: string;
  readonly canonicalBackupPath: string;
  readonly operation: CodexHistoryWorkerOperation;
  readonly expectedDesiredEnabled?: boolean;
}

export type CodexHistoryJobOutcome =
  | { readonly kind: "converged"; readonly rows: number; readonly files: number; readonly proof?: CodexHistoryVerifiedNoopProof }
  | { readonly kind: "skipped" }
  | { readonly kind: "blocked"; readonly reason: "busy" | "database" | "unsafe-path" | "desired_disabled" | "desired_enabled" }
  | { readonly kind: "failed"; readonly reason: "worker-error" | "worker-died" | "timeout";
      readonly message: string; readonly historyFailureReason?: CodexHistoryFailureReason;
      /** Specific integrity condition when `historyFailureReason` is `"integrity"`. */
      readonly historyIntegrityCode?: string;
      readonly rows?: number; readonly files?: number };

/**
 * Derive the durable history operation from admitted intent.
 *
 * `resumeHistory === false` is the user's explicit opt-out and outranks the
 * direction entirely — an apply that quietly migrated history anyway would be
 * the setting failing silently. `legacyMode` is the only case that routes
 * history TO opencodex; the ordinary apply migrates to native so a later restore
 * has nothing to undo.
 */
/**
 * Test seam: the boundary suite exercises the validator without standing up a
 * Worker whose malformed message it cannot easily emit from inside a test.
 */
export function isPlausibleWorkerResultForTests(
  message: Record<string, unknown>,
  requestId: string,
  jobId: string,
  target?: Pick<CodexHistoryJobRequest, "canonicalStateDbPath" | "canonicalBackupPath" | "operation">,
): boolean {
  return isPlausibleWorkerResult(message, requestId, jobId, target);
}

/**
 * Reject a message that names a recognized type but lacks its payload.
 *
 * Without this, `{requestId, type:"done"}` reached an unchecked cast and read
 * as `converged` with undefined fields — a success report for work that may not
 * have happened. Each type is checked for the fields it actually carries, and
 * the ids are matched against the request in flight, not merely present.
 */
function isPlausibleWorkerResult(
  message: Record<string, unknown>,
  requestId: string,
  jobId: string,
  target?: Pick<CodexHistoryJobRequest, "canonicalStateDbPath" | "canonicalBackupPath" | "operation">,
): boolean {
  if (message.requestId !== requestId || message.jobId !== jobId) return false;
  switch (message.type) {
    case "done":
      if (!((message.outcome === "converged" || message.outcome === "skipped")
        && typeof message.rows === "number"
        && typeof message.files === "number")) return false;
      if (message.proof === undefined) return true;
      if (!target || !message.proof || typeof message.proof !== "object" || Array.isArray(message.proof)) return false;
      {
        const proof = message.proof as Record<string, unknown>;
        return target.operation === "migrate-openai"
          && message.outcome === "converged"
          && message.rows === 0
          && message.files === 0
          && proof.kind === "verified-noop"
          && proof.pendingRows === 0
          && proof.backupEntries === 0
          && proof.canonicalStateDbPath === target.canonicalStateDbPath
          && proof.stateDbPresent === true
          && proof.canonicalBackupPath === target.canonicalBackupPath
          && typeof proof.backupPresent === "boolean";
      }
    case "blocked":
      return message.reason === "busy" || message.reason === "database" || message.reason === "unsafe-path"
        || message.reason === "desired_disabled" || message.reason === "desired_enabled";
    case "error":
      return typeof message.message === "string"
        && (message.rows === undefined || (Number.isSafeInteger(message.rows) && Number(message.rows) >= 0))
        && (message.files === undefined || (Number.isSafeInteger(message.files) && Number(message.files) >= 0))
        && ((message.rows === undefined && message.files === undefined)
          || (message.rows !== undefined && message.files !== undefined))
        && (message.reason === undefined
          || message.reason === "busy"
          || message.reason === "permission"
          || message.reason === "integrity");
    default:
      return false;
  }
}

export function deriveCodexHistoryOperation(intent: {
  readonly direction: "apply" | "restore";
  readonly resumeHistory: boolean;
  readonly legacyMode: boolean;
}): CodexHistoryWorkerOperation {
  if (!intent.resumeHistory) return "skip";
  if (intent.direction === "restore") return "restore-openai";
  return intent.legacyMode ? "apply-opencodex" : "migrate-openai";
}

/**
 * The honest failure clause for one history job outcome.
 *
 * The caller adds its own framing ("sync SKIPPED", "could NOT be restored").
 * The point of the surface argument is that a genuine lock keeps today's
 * actionable wording, while every other reason stops blaming the Codex app:
 * an unsafe-path refusal, an unavailable coordinator database, a permission
 * denial, or a dead worker is a different problem with a different remedy.
 */
export function describeHistoryJobFailure(
  outcome: CodexHistoryJobOutcome,
  surface: "apply" | "restore" | "recover-legacy",
  legacyMode = false,
): string {
  // Callers only invoke this after observing a failure flag, but that flag is
  // derived from "not converged", which also covers "skipped". Naming those
  // two kinds keeps a widened or miscast call site from printing `undefined`.
  if (outcome.kind === "skipped") {
    return "the history operation was skipped; no failure was recorded.";
  }
  if (outcome.kind === "converged") {
    return "the history job reported no failure; run 'ocx doctor' if this is unexpected.";
  }
  // A busy database reaches here two ways: the lock itself was contended
  // (blocked/busy), or the lock was acquired and the worker then found SQLite
  // busy (failed with historyFailureReason "busy"). Both are the same user
  // situation and deserve the same surface-specific guidance.
  const busyText = surface === "apply"
    ? legacyMode
      ? "the history DB is locked (Codex app/IDE open?). Close it and rerun 'ocx start'."
      : "the history DB is locked (Codex app/IDE open?). It is retried automatically (while the proxy runs and on every 'ocx start'); to force it now, close the Codex app and run 'ocx sync'."
    : surface === "recover-legacy"
      ? "the Codex history DB is locked (Codex app/IDE open?). Close it and rerun this command."
      : "the Codex app appears to be holding the history database. Close Codex and run `ocx restore` again.";
  const busyStateText = "Codex history state is busy (database, backup manifest, or rollout file); this is not enough evidence to blame the Codex app. It is retried automatically while the proxy runs; run 'ocx doctor' before forcing another attempt.";
  if (outcome.kind === "blocked") {
    if (outcome.reason === "busy") return busyText;
    switch (outcome.reason) {
      case "unsafe-path":
        return "opencodex refused its history lock path (unsafe coordinator namespace); this is not a Codex app lock. Run 'ocx doctor' and check the opencodex runtime directory.";
      case "database":
        return "the history coordinator database is unavailable; this is not a Codex app lock. Run 'ocx doctor'.";
      case "desired_disabled":
        return "Codex integration is disabled, so the history operation was skipped.";
      case "desired_enabled":
        return "Codex integration is enabled, so the history operation was skipped.";
    }
  }
  const partiallyChanged = (outcome.rows ?? 0) > 0 || (outcome.files ?? 0) > 0;
  if (partiallyChanged && outcome.historyFailureReason === "busy") {
    return "Codex history metadata changed but did not converge because manifest finalization remained busy; the manifest was retained for review and safe retry. Run 'ocx doctor'.";
  }
  if (partiallyChanged && outcome.historyFailureReason === "permission") {
    return "Codex history metadata changed but did not converge because permission was denied while finalizing the manifest; the manifest was retained for review and safe retry. Run 'ocx doctor'.";
  }
  if (outcome.historyFailureReason === "busy") return busyStateText;
  if (outcome.historyFailureReason === "permission") {
    return "permission was denied while writing Codex history; this is not a Codex app lock. Run 'ocx doctor'.";
  }
  if (outcome.historyFailureReason === "integrity") {
    // Not every integrity stop is a retry. An ambiguous reroute means two histories
    // produced the same row and no durable fact separates them, so retrying reaches the
    // same refusal - the manifest needs a person, and saying "run doctor" sends them the
    // wrong way.
    if (outcome.historyIntegrityCode === "history_apply_ambiguous_reroute") {
      return "a Codex history entry could not be re-routed because its manifest cannot prove whether an earlier relabel was undone; nothing was changed and the manifest was kept. Resolve it manually rather than retrying.";
    }
    return partiallyChanged
      ? "the history backup or its restore target changed after a partial restore; the manifest was retained for review and safe retry. Run 'ocx doctor'."
      : "the history backup or its restore target failed integrity checks; no unverified provider metadata was applied. Run 'ocx doctor'.";
  }
  switch (outcome.reason) {
    case "worker-error":
      return `the history worker failed (${outcome.message}). Run 'ocx doctor'.`;
    case "worker-died":
      return "the history worker exited unexpectedly; this is not a Codex app lock. Run 'ocx doctor'.";
    case "timeout":
      return "the history worker timed out; this is not a Codex app lock. Run 'ocx doctor'.";
  }
}

/**
 * Worker exceptions travel into user-facing CLI output, and a raw filesystem
 * error carries absolute paths — on every platform that includes the account
 * name (`/Users/x`, `/home/x`, `C:\Users\x`). Folding the home directory to
 * `~` keeps the diagnostic value and drops the identifier.
 */
function redactWorkerMessage(message: string): string {
  const home = homedir();
  if (home.length <= 1) return message;
  // Windows spellings vary in case and separator; an exact match would leave
  // the account name in the message.
  if (process.platform === "win32") {
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\\/g, "[\\\\/]");
    return message.replace(new RegExp(escaped, "gi"), "~");
  }
  return message.split(home).join("~");
}

function classifyWorkerResult(result: HistoryWorkerResult): CodexHistoryJobOutcome {
  if (result.type === "blocked") return { kind: "blocked", reason: result.reason };
  if (result.type === "error") {
    return {
      kind: "failed",
      reason: "worker-error",
      message: redactWorkerMessage(result.message),
      ...(result.reason ? { historyFailureReason: result.reason } : {}),
      ...(result.integrityCode ? { historyIntegrityCode: result.integrityCode } : {}),
      ...(result.rows !== undefined && result.files !== undefined
        ? { rows: result.rows, files: result.files }
        : {}),
    };
  }
  return result.outcome === "skipped"
    ? { kind: "skipped" }
    : { kind: "converged", rows: result.rows, files: result.files, ...(result.proof ? { proof: result.proof } : {}) };
}

/** Test seam for the parent-side Worker result classification contract. */
export function classifyWorkerResultForTests(result: HistoryWorkerResult): CodexHistoryJobOutcome {
  return classifyWorkerResult(result);
}

/**
 * Run one history unit in a Worker and join it before returning.
 *
 * The join is not optional politeness: returning while the thread may still be
 * mutating CODEX_HOME would let a caller's next step observe a half-applied
 * transition, and would let a test suite reach its next file with a worker still
 * exiting behind it.
 */
export async function runCodexHistoryJob(
  request: CodexHistoryJobRequest,
  options: { readonly timeoutMs?: number } = {},
): Promise<CodexHistoryJobOutcome> {
  const requestId = randomUUID();
  const jobId = randomUUID();
  const timeoutMs = options.timeoutMs ?? WORKER_TIMEOUT_MS;

  // `skip` writes nothing, so spawning a thread to decide that would be pure
  // cost. It still returns a recorded outcome rather than silence.
  if (request.operation === "skip") return { kind: "skipped" };

  let worker: Worker;
  try {
    worker = new Worker(new URL("./history-worker.ts", import.meta.url).href);
  } catch (error) {
    return {
      kind: "failed",
      reason: "worker-died",
      message: error instanceof Error ? error.message : "history_worker_spawn_failed",
    };
  }

  return new Promise<CodexHistoryJobOutcome>(resolve => {
    let settled = false;
    let resolveWorkerClosed!: () => void;
    const workerClosed = new Promise<void>(closed => {
      resolveWorkerClosed = closed;
    });
    const finish = (outcome: CodexHistoryJobOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Bun 1.3.14 returns void from terminate(); resolving on that return lets
      // the Worker outlive this job and, under `bun test --isolate`, its file.
      void terminateAndJoinHistoryWorker(worker, workerClosed).then(joined => {
        resolve(joined
          ? outcome
          : { kind: "failed", reason: "worker-died", message: "history_worker_close_timeout" });
      }, () => {
        resolve({ kind: "failed", reason: "worker-died", message: "history_worker_join_failed" });
      });
    };

    const timer = setTimeout(() => {
      finish({ kind: "failed", reason: "timeout", message: "history_worker_timeout" });
    }, timeoutMs);

    const died = (detail: string): void => {
      finish({ kind: "failed", reason: "worker-died", message: detail });
    };

    worker.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (!data || typeof data !== "object") {
        // Not the shape at all: this is a death signal, not silence. Ignoring it
        // would let the watchdog call a dead Worker a timeout.
        died("history_worker_malformed_message");
        return;
      }
      const message = data as Record<string, unknown>;
      // A reply for a different request is somebody else's; ignoring it is not
      // the same as accepting it.
      if (message.requestId !== requestId) return;
      if (message.type !== "done" && message.type !== "blocked" && message.type !== "error") {
        died("history_worker_unknown_message_type");
        return;
      }
      if (!isPlausibleWorkerResult(message, requestId, jobId, request)) {
        // A recognized type with a missing payload read as `converged` with
        // undefined fields once — success for work that may not have happened.
        died("history_worker_malformed_payload");
        return;
      }
      finish(classifyWorkerResult(message as unknown as HistoryWorkerResult));
    };

    /*
     * A Worker that exits early — without erroring — is not an error event, so
     * without these it surfaced as `timeout` after the full wait. Both are death
     * signals. Neither can overturn a settled success: `finish` is idempotent,
     * and the Worker always closes after posting its result.
     */
    worker.addEventListener("messageerror", () => died("history_worker_unserializable_message"));
    worker.addEventListener("close", () => {
      resolveWorkerClosed();
      died("history_worker_closed_early");
    }, { once: true });

    worker.onerror = (event: ErrorEvent) => {
      finish({
        kind: "failed",
        reason: "worker-died",
        message: event.message || "history_worker_failed",
      });
    };

    worker.postMessage({
      type: "run",
      requestId,
      jobId,
      operation: request.operation,
      canonicalCodexHome: request.canonicalCodexHome,
      canonicalStateDbPath: request.canonicalStateDbPath,
      canonicalBackupPath: request.canonicalBackupPath,
      ...(request.expectedDesiredEnabled === undefined ? {} : { expectedDesiredEnabled: request.expectedDesiredEnabled }),
      env: {
        ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
        ...(process.env.OPENCODEX_HOME ? { OPENCODEX_HOME: process.env.OPENCODEX_HOME } : {}),
      },
    });
  });
}
