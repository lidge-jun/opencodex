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
  return Array.isArray(value)
    && value.every(entry => typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0);
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
  const surviving = view.surviving as number[];
  const failed = view.failed as number[];
  const stopped = view.stopped as number[];

  // `success` and `code` must agree: only partially_stopped is an unsuccessful code.
  if (success !== (code !== "partially_stopped")) return false;
  // A clean outcome cannot leave anything behind.
  if (success && (surviving.length > 0 || failed.length > 0)) return false;
  // An unsuccessful outcome must name what survived.
  if (!success && surviving.length === 0 && failed.length === 0) return false;
  // Nothing can be reported stopped when the service says nothing was running.
  if ((code === "nothing_running" || code === "enumeration_unavailable") && stopped.length > 0) {
    return false;
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

