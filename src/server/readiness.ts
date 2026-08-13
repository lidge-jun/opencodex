/**
 * Per-server readiness gate for the opencodex proxy.
 *
 * `GET /healthz` answers "is the process alive and serving HTTP?" the instant the
 * listener binds. Readiness is stricter: the proxy is "ready" only after the
 * post-startup Codex catalog/config sync (`syncModelsToCodex`) has settled with
 * `ok=true` and no catalog-sync warning. Until then the process is live (Codex can
 * open a socket) but not ready (a request would race the sync or hit a stale
 * catalog), so clients should back off.
 *
 * Design contract (per P1 review):
 *  - NO module-global mutable state. Each `startServer` invocation gets its own
 *    private gate via `createReadinessGate()`, captured by that listener's
 *    closure. Starting/failing a second server in the same process can never
 *    reset or mutate the first server's gate.
 *  - Only the fixed sanitized status enum `pending | ready | failed` is stored
 *    and exposed. There is no `changedAt`, no free-form failure reason, no sync
 *    message, no warning text, no catalog path, no provider output, and no
 *    account data — those are private diagnostic data and are never exposed by
 *    `/readyz`.
 */

/** Sanitized readiness state. Exactly these three values, nothing else. */
export type ReadinessStatus = "pending" | "ready" | "failed";

/**
 * Private per-server readiness controller. The status starts at `pending` and
 * transitions at most once (to `ready` or `failed`) when the post-startup sync
 * settles. The gate is owned by the listener closure that requested it.
 */
export interface ReadinessGate {
  /** Current sanitized status. */
  getStatus(): ReadinessStatus;
  /** Mark the proxy ready (post-startup sync settled cleanly). */
  markReady(): void;
  /** Mark the proxy failed. No reason is stored or exposed. */
  markFailed(): void;
}

/**
 * Create a fresh private gate for one `startServer` invocation. The returned
 * gate is the only way to read or mutate this server's readiness.
 */
export function createReadinessGate(): ReadinessGate {
  let status: ReadinessStatus = "pending";
  return {
    getStatus: () => status,
    markReady: () => {
      if (status === "pending") status = "ready";
    },
    markFailed: () => {
      if (status === "pending") status = "failed";
    },
  };
}

/** Minimal shape of the post-startup sync outcome the gate cares about. */
export interface SyncOutcomeLike {
  ok?: boolean;
  warning?: string;
  /** #1046: whether the sync actually rewrote the on-disk catalog/cache. */
  catalogWritten?: boolean;
  cacheSynced?: boolean;
}

/**
 * Drive the gate from the post-startup sync. Awaits `syncFn`; the gate goes to
 * `ready` ONLY on `ok=true` with no nonempty warning. A throw, `null`, `ok=false`,
 * or a nonempty warning transitions to `failed`. Used directly by `handleStart`
 * so the startup transition is unit-testable without spawning the proxy. Returns
 * the raw sync outcome so a caller that also needs the #1046 write flags (did the
 * sync actually write the catalog/cache?) can keep them without a second call.
 */
export async function runStartupReadinessSync(
  gate: ReadinessGate,
  syncFn: () => Promise<SyncOutcomeLike | null>,
): Promise<SyncOutcomeLike | null> {
  let result: SyncOutcomeLike | null;
  try {
    result = await syncFn();
  } catch {
    gate.markFailed();
    return null;
  }
  if (result === null) {
    gate.markFailed();
    return null;
  }
  if (result.ok !== true) {
    gate.markFailed();
    return result;
  }
  if (result.warning !== undefined && result.warning !== "") {
    gate.markFailed();
    return result;
  }
  gate.markReady();
  return result;
}
