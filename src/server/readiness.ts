/**
 * Per-server readiness gate for the opencodex proxy.
 *
 * `GET /healthz` answers "is the process alive and serving HTTP?" the instant the
 * listener binds. Readiness is stricter: the proxy is "ready" only after the
 * post-startup Codex catalog/config sync (`syncModelsToCodex`) has SETTLED and
 * reported `ok=true`. Until it settles the process is live (Codex can open a
 * socket) but not ready — a request would race the sync — so clients back off.
 *
 * What readiness is NOT (#5181): it is not a verdict on the local Codex client's
 * artifacts. A nonempty `warning` used to be terminal here, which made a
 * degradation of files written into the local Codex home permanently un-ready a
 * proxy that was serving every other provider correctly. In a single-replica
 * Kubernetes deployment that removed the only Service endpoint.
 *
 * `ok` and `warning` are separate fields in the sync result because they answer
 * separate questions, and the gate must not conflate them. `ok` is the sync's own
 * verdict on whether the essential work — config injection, and the write
 * admission that precedes it — succeeded. `warning` names a degradation the sync
 * itself decided to continue past: no catalog source so Codex keeps its native
 * catalog, combos omitted from the catalog, a conversation-history relabel left
 * to Codex's own writer, or a caught catalog-refresh exception after which
 * injection still runs and still reports its own `ok`. None of those stops this
 * process from accepting HTTP or routing to a provider, so none of them may close
 * the gate.
 *
 * That boundary is not new, only extended: the Claude Code roster reconciliation
 * in `src/cli/claude-agent-startup-sync.ts` already delays the ready transition
 * without being allowed to fail it, on the same reasoning.
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
 * `ready` on `ok=true`. A throw, `null`, or `ok !== true` transitions to
 * `failed`; a nonempty `warning` does not, because the sync that produced it
 * still reported the essential work done (see the file header, #5181). A throw
 * and `null` stay terminal because neither is a classified outcome: the startup
 * path did not reach a verdict, so the gate cannot claim one. Used by `handleStart`
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
  gate.markReady();
  return result;
}
