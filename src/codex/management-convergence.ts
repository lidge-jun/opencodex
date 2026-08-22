import type { OcxConfig } from "../types";
import { captureCatalogAdmissionSnapshot } from "./catalog-admission";
import { convergeCodexCatalog } from "./convergence";
import type {
  CatalogDisposition,
  CatalogFailureCause,
  CatalogOnlyOutcome,
  CodexHistoryState,
  CodexObservedState,
  ConvergeCodex,
  ProjectCatalogOnlyOutcomeInput,
} from "./convergence-types";

function notEvaluatedHistory(): CodexHistoryState {
  return {
    status: "not-evaluated",
    attempts: 0,
    nextRetryAt: null,
    txId: null,
    pendingRows: null,
    backupEntries: null,
  };
}

function notEvaluatedObserved(history: CodexHistoryState): CodexObservedState {
  return {
    aggregate: "not-evaluated",
    isApplied: null,
    desired: "unknown",
    converged: null,
    authority: { service: "unknown", externalProvider: null },
    surfaces: {
      config: "not-evaluated",
      profile: "not-evaluated",
      catalog: "not-evaluated",
      cache: "not-evaluated",
      journal: "not-evaluated",
      history: {
        state: history,
        database: "not-evaluated",
        manifest: "not-evaluated",
        rollouts: "not-evaluated",
      },
      provenance: {
        state: "not-evaluated",
        nativeGeneration: null,
        currentTxId: null,
      },
    },
  };
}

/** Recognized errno/code tokens. Anything else is dropped rather than echoed. */
const RECOGNIZED_FAILURE_CODES: ReadonlySet<string> = new Set([
  "ENOSPC", "EACCES", "EPERM", "EROFS", "ENOENT", "SQLITE_BUSY",
]);

/**
 * Reduce a caught error to an allowlisted cause (#1784).
 *
 * Nothing from the error text reaches the caller: `kind` is chosen from a closed set and
 * `code` is only emitted when it is a recognized token. An `Error.message` routinely carries
 * paths, home directories and account ids, and `redactSecretString` masks token shapes but
 * none of those, so the message is never a safe thing to forward from here.
 */
function catalogFailureCause(error: unknown): CatalogFailureCause {
  const raw = (error as { code?: unknown } | null)?.code;
  const code = typeof raw === "string" && RECOGNIZED_FAILURE_CODES.has(raw)
    ? raw as CatalogFailureCause["code"]
    : undefined;
  if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) {
    return { kind: "invalid-request", ...(code ? { code } : {}) };
  }
  if (code === "SQLITE_BUSY") return { kind: "lock-busy", code };
  if (code !== undefined) return { kind: "io", code };
  return { kind: "unknown" };
}

/**
 * Classify a failure that is NOT a filesystem problem.
 *
 * `disk` used to be the catch-all, so an operator saw "non-retryable disk failure" for a
 * malformed request. Reserve `disk` for real IO and route the rest to honest reasons.
 */
function classifiedCatalogFailure(error: unknown, commitBegan: boolean): CatalogDisposition {
  const cause = catalogFailureCause(error);
  const reason = cause.kind === "invalid-request"
    ? "request-invalid" as const
    : cause.kind === "lock-busy"
      ? "admission" as const
      : cause.kind === "io"
        ? "disk" as const
        : "internal" as const;
  return {
    status: "failed",
    reason,
    phase: commitBegan ? "commit" : "gather",
    // Contention is the one class worth retrying unchanged.
    retryable: reason === "admission",
    partialWrite: commitBegan,
    cause,
  };
}

function unexpectedCatalogFailure(commitBegan: boolean): CatalogDisposition {
  return {
    status: "failed",
    reason: "disk",
    phase: commitBegan ? "commit" : "gather",
    retryable: false,
    partialWrite: commitBegan,
  };
}

function admissionFailure(error: unknown): CatalogDisposition {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("config generation is busy") || message.includes("config generation is database")) {
    return { status: "skipped", reason: "busy", retryable: true };
  }
  return classifiedCatalogFailure(error, false);
}

/** Project catalog work into the shared no-change/not-evaluated outcome shape. */
export function projectCatalogOnlyOutcome({
  changed,
  catalogRefresh,
}: ProjectCatalogOnlyOutcomeInput): CatalogOnlyOutcome {
  const history = notEvaluatedHistory();
  return {
    kind: "catalog-only",
    changed,
    observed: notEvaluatedObserved(history),
    catalogRefresh,
    history,
  };
}

/**
 * Bind the management callback's exact config authority to a catalog-only
 * funnel. This module is intentionally not re-exported by a public Codex facade.
 */
export function createManagementConvergeCodex(
  config: Readonly<OcxConfig>,
): ConvergeCodex {
  const retainedConfig = config;
  return async request => {
    let commitBegan = false;
    try {
      if (request.scope !== "catalog" || request.action !== "converge") {
        return projectCatalogOnlyOutcome({
          changed: false,
          catalogRefresh: unexpectedCatalogFailure(false),
        });
      }
      const snapshot = captureCatalogAdmissionSnapshot(retainedConfig);
      const result = await convergeCodexCatalog(snapshot, request, {
        onCommitBegin: () => { commitBegan = true; },
      });
      return projectCatalogOnlyOutcome(result);
    } catch (error) {
      return projectCatalogOnlyOutcome({
        changed: false,
        catalogRefresh: commitBegan ? classifiedCatalogFailure(error, true) : admissionFailure(error),
      });
    }
  };
}
