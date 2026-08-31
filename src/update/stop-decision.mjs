import { STOP_HISTORY_INCOMPLETE_EXIT_CODE } from "./stop-contract.mjs";

/**
 * May an update replace package files after `ocx stop` returned?
 *
 * Both updaters ask this: `src/update/index.ts` on the Bun path and `bin/ocx.mjs` on the
 * npm path the dashboard uses. It lives here as plain ESM so the Node launcher can import
 * it, and so the two lanes cannot drift into disagreeing about the same situation — which
 * is how #3008 shipped in the first place, with the fix on one side only.
 *
 * Returns `{ proceed, reason }`. The reasons are:
 *
 * - `stop-failed` — a nonzero status other than the history-only code, or a signal kill.
 *   A signal kill carries no evidence the teardown finished, so it is not a maybe.
 * - `runtime-state` — a PID or runtime-port record survived the stop.
 * - `proxy-live` — something is still answering as our proxy on the captured endpoint.
 * - `proxy-unknown` — the probe could not answer. Absence of proof is not proof of
 *   absence, and replacing files under a live server leaves it running a mix of old and
 *   new modules.
 * - `ok` / `history-only` — proceed; the second also prints the manifest warning.
 */
export function decidePostStopUpdate({ status, hasRuntimeState, liveness }) {
  const historyOnly = status === STOP_HISTORY_INCOMPLETE_EXIT_CODE;
  if (status !== 0 && !historyOnly) return { proceed: false, reason: "stop-failed" };
  if (hasRuntimeState) return { proceed: false, reason: "runtime-state" };
  if (liveness === "live") return { proceed: false, reason: "proxy-live" };
  if (liveness !== "dead") return { proceed: false, reason: "proxy-unknown" };
  return { proceed: true, reason: historyOnly ? "history-only" : "ok" };
}
