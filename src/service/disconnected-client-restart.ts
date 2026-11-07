import { assertNoClientDisconnectPending, pendingClientConnectMayOwnToken, readClientConnectionState } from "../client/state";
import { readRuntimePort, verifyPidIdentity } from "../config/process-state";
import { isProcessAlive, stopProxy } from "../lib/process-control";
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
 * Connected Children and foreign/unproven processes never enter this cleanup path.
 */
export async function prepareDisconnectedClientServiceRestart(deps: DisconnectedClientRestartDeps): Promise<void> {
  const disconnected = deps.disconnected ?? (() => {
    assertNoClientDisconnectPending();
    return readClientConnectionState().kind === "disconnected" && !pendingClientConnectMayOwnToken();
  });
  if (!disconnected()) return;
  const live = await (deps.findLive ?? (() => findLiveProxy({ ...SERVICE_STOP_LIVENESS, acceptPackageTreeFenced: true })))();
  if (live?.role !== "client") return;
  const pid = live.pid;
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Disconnected client PID is unverified; rerun 'ocx service restart'.");
  const alive = deps.alive ?? isProcessAlive;
  const verify = deps.verify ?? (candidate => readRuntimePort(candidate)?.pid === candidate ? verifyPidIdentity(candidate) : null);
  if (verify(pid) !== pid || !disconnected()) throw new Error("Disconnected client ownership changed; rerun 'ocx disconnect', then 'ocx service restart'.");
  deps.beforeStop?.();
  await deps.stopManager();
  deps.beforeStop?.();
  if (!disconnected()) throw new Error("Client connection changed during service restart; no replacement was started.");
  if (alive(pid)) {
    if (verify(pid) !== pid) throw new Error("Surviving client PID ownership is unverified; service restart stopped without killing it.");
    await (deps.stop ?? stopProxy)(pid);
  }
  if (alive(pid)) throw new Error("Disconnected client did not exit; rerun 'ocx service restart'.");
}
