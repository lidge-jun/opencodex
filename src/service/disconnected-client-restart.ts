import { clearPendingTeardown } from "../config/pending-teardown";
import { assertNoClientDisconnectPending, pendingClientConnectMayOwnToken, readClientConnectionState } from "../client/state";
import { readRuntimePort, verifyPidIdentity } from "../config/process-state";
import { isProcessAlive } from "../lib/process-control";
import { findLiveProxy, SERVICE_STOP_LIVENESS } from "../server/proxy-liveness";

export interface DisconnectedClientRestartDeps {
  disconnected?: () => boolean;
  findLive?: () => Promise<{ pid?: number; role?: string } | null>;
  stopManager: () => void | Promise<void>;
  beforeStop?: () => void;
  alive?: (pid: number) => boolean;
  verify?: (pid: number) => number | null;
  stop?: (pid: number) => Promise<unknown>;
}

/** A service stop can leave a detached Child alive (notably Task Scheduler /end).
 * Settle that exact, home-verified process before the manager starts standalone.
 * Connected Children, foreign/unproven processes and an interrupted disconnect never enter this
 * cleanup path: the restart then proceeds exactly as it did before this cleanup existed, and an
 * interrupted disconnect is finished by running `ocx disconnect` again.
 */
export async function prepareDisconnectedClientServiceRestart(deps: DisconnectedClientRestartDeps): Promise<void> {
  const disconnected = deps.disconnected ?? (() => {
    assertNoClientDisconnectPending();
    return readClientConnectionState().kind === "disconnected" && !pendingClientConnectMayOwnToken();
  });
  try { if (!disconnected()) return; }
  catch { return; }
  const live = await (deps.findLive ?? (() => findLiveProxy({ ...SERVICE_STOP_LIVENESS, acceptPackageTreeFenced: true })))();
  if (live?.role !== "client") return;
  const pid = live.pid;
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Disconnected client PID is unverified; rerun 'ocx service restart'.");
  const alive = deps.alive ?? isProcessAlive;
  let homeVerified = false;
  const verify = deps.verify ?? (candidate => {
    const runtime = readRuntimePort();
    if (runtime && runtime.pid !== candidate) return null;
    if (runtime?.pid === candidate) homeVerified = true;
    // Shutdown removes its record before it necessarily exits. The pre-stop
    // home binding still applies, but process identity must be proved again.
    return homeVerified ? verifyPidIdentity(candidate) : null;
  });
  // A client proxy this home cannot prove is its own is not ours to stop.
  if (verify(pid) !== pid) return;
  if (!disconnected()) throw new Error("Disconnected client ownership changed; rerun 'ocx disconnect', then 'ocx service restart'.");
  deps.beforeStop?.();
  await deps.stopManager();
  deps.beforeStop?.();
  if (!disconnected()) throw new Error("Client connection changed during service restart; no replacement was started.");
  if (alive(pid)) {
    if (verify(pid) !== pid) throw new Error("Surviving client PID ownership is unverified; service restart stopped without killing it.");
    // Receipt-backed: a Task Scheduler restart keeps the task registered, so a bare stop is refused.
    // The scheduler restart passes a stop that holds the receipt until its replacement serves; a
    // manager that already ended the process never reaches here, so the default releases at once.
    await (deps.stop ?? (async (target: number) => (await import("./restart-proxy-stop")).stopProxyForServiceRestart(target,
      receipt => { clearPendingTeardown(receipt.nonce); })))(pid);
  }
  if (alive(pid)) throw new Error("Disconnected client did not exit; rerun 'ocx service restart'.");
}
