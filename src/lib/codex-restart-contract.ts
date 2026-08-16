/**
 * Contract for the dashboard-driven Codex app-server restart (#1046 follow-up).
 *
 * Distinct from `system-restart-contract.ts`: that one restarts THIS proxy process
 * and needs a pid-bound capability because it kills its own listener. This one asks
 * matching Codex app-server children to exit so Codex rereads the catalog on next
 * launch. It never touches the proxy and never spawns a replacement — whoever owns
 * the app-server (the Codex app, an SSH bootstrap) relaunches it on next use.
 *
 * Scalar-only payload. A command line can contain a home directory and a username,
 * and an OS error message often embeds a path, so neither crosses this boundary.
 *
 * Design and audit history: `devlog/_fin/260815_gui_codex_restart/`.
 */

export const CODEX_RESTART_METHOD = "POST";
export const CODEX_RESTART_PATH = "/api/system/codex-restart";
export const CODEX_APP_SERVER_STATE_PATH = "/api/system/codex-app-server";

/** Mirrors CodexAppServerCatalogState so the GUI never imports runtime code. */
export type CodexAppServerState = "fresh" | "stale" | "not_running" | "unknown";

/**
 * `nothing_running` is retained for wire compatibility. It means no stale
 * restart target remained, not necessarily that the process list was empty;
 * stateBefore distinguishes fresh, not-running, and exited-before-signal cases.
 */
export type CodexRestartCode =
  | "stopped"
  | "nothing_running"
  | "enumeration_unavailable"
  | "partially_stopped";

/** GET response: a cheap reading with no side effects. It never signals. */
export interface CodexAppServerStateResponse {
  state: CodexAppServerState;
  runningCount: number;
}

/** POST response. All four arrays are pid lists — never command lines. */
export interface CodexRestartResponse {
  success: boolean;
  /** Classifier reading taken BEFORE any signal, so the UI can explain why it acted. */
  stateBefore: CodexAppServerState;
  /** Whether a catalog or cache write happened during this request. */
  synced: boolean;
  requested: number[];
  stopped: number[];
  surviving: number[];
  failed: number[];
  code: CodexRestartCode;
}

const APP_SERVER_STATES: readonly string[] = ["fresh", "stale", "not_running", "unknown"];
const RESTART_CODES: readonly string[] = [
  "stopped",
  "nothing_running",
  "enumeration_unavailable",
  "partially_stopped",
];

/**
 * A pid is a positive safe integer. Accepting a float or a negative number would
 * let a malformed body reach UI code that renders counts and indexes lengths.
 */
function isPidList(value: unknown): value is number[] {
  if (!Array.isArray(value)) return false;
  if (!value.every(entry =>
    typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0
  )) return false;
  return new Set(value).size === value.length;
}

function isSubset(subset: ReadonlySet<number>, superset: ReadonlySet<number>): boolean {
  for (const pid of subset) {
    if (!superset.has(pid)) return false;
  }
  return true;
}

/**
 * Runtime guard for GUI consumers: a 2xx body is not automatically this shape.
 *
 * Structure is not enough. A body can be structurally valid and still contradict
 * itself — `code: "stopped"` alongside surviving pids, or `success: true` with a
 * failure code — and a caller that trusts it reports a success that did not happen.
 * A version-skewed or regressed proxy is exactly how that arrives, so the
 * cross-field invariants are checked here rather than assumed.
 */
export function isCodexRestartResponse(value: unknown): value is CodexRestartResponse {
  if (typeof value !== "object" || value === null) return false;
  const view = value as Record<string, unknown>;
  const structural = typeof view.success === "boolean"
    && typeof view.synced === "boolean"
    && typeof view.stateBefore === "string"
    && APP_SERVER_STATES.includes(view.stateBefore)
    && typeof view.code === "string"
    && RESTART_CODES.includes(view.code)
    && isPidList(view.requested)
    && isPidList(view.stopped)
    && isPidList(view.surviving)
    && isPidList(view.failed);
  if (!structural) return false;

  const success = view.success as boolean;
  const code = view.code as CodexRestartCode;
  const stateBefore = view.stateBefore as CodexAppServerState;
  const requested = view.requested as number[];
  const surviving = view.surviving as number[];
  const failed = view.failed as number[];
  const stopped = view.stopped as number[];
  const requestedSet = new Set(requested);
  const stoppedSet = new Set(stopped);
  const survivingSet = new Set(surviving);
  const failedSet = new Set(failed);

  // `success` and `code` must agree: only partially_stopped is an unsuccessful code.
  if (success !== (code !== "partially_stopped")) return false;
  // The code must describe the classifier state that can produce it. A stale
  // target may exit before signalling, so stale+nothing_running is intentional;
  // unknown is never a clean no-op, and fresh/not-running can never be stopped.
  if ((code === "stopped" || code === "partially_stopped") && stateBefore !== "stale") {
    return false;
  }
  if (code === "enumeration_unavailable" && stateBefore !== "unknown") return false;
  if (code === "nothing_running" && stateBefore === "unknown") return false;

  // Every terminal bucket is an accounting of a requested pid. A failed signal
  // remains a survivor, while a stopped pid cannot simultaneously be live.
  if (!isSubset(stoppedSet, requestedSet) || !isSubset(survivingSet, requestedSet)) return false;
  if (!isSubset(failedSet, survivingSet)) return false;
  for (const pid of stoppedSet) {
    if (survivingSet.has(pid)) return false;
  }

  if (code === "nothing_running" || code === "enumeration_unavailable") {
    return requested.length === 0
      && stopped.length === 0
      && surviving.length === 0
      && failed.length === 0;
  }

  if (requested.length === 0) return false;
  if (code === "stopped") {
    return surviving.length === 0
      && failed.length === 0
      && stoppedSet.size === requestedSet.size;
  }

  // A partial result must account for every request as either stopped or still
  // alive. failed is diagnostic detail for the surviving subset.
  if (surviving.length === 0) return false;
  for (const pid of requestedSet) {
    if (!stoppedSet.has(pid) && !survivingSet.has(pid)) return false;
  }
  return true;
}

export function isCodexAppServerStateResponse(
  value: unknown,
): value is CodexAppServerStateResponse {
  if (typeof value !== "object" || value === null) return false;
  const view = value as Record<string, unknown>;
  return typeof view.state === "string"
    && APP_SERVER_STATES.includes(view.state)
    && typeof view.runningCount === "number"
    && Number.isSafeInteger(view.runningCount)
    && view.runningCount >= 0;
}
