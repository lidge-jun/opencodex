/**
 * `ocx uninstall`'s proxy stop, extracted from `handleUninstall` so the decision is
 * callable rather than only readable (#7771, #3008).
 *
 * The step has two jobs that used to be implicit in the command body: find the proxy
 * (tracked pid, or an identity-checked orphan), and stop it without letting a wrapper
 * relaunch it after shared client config has already been restored.
 *
 * On Windows the stop is deferred exactly as `ocx stop` and `ocx service stop` do it: a
 * teardown receipt is claimed BEFORE the child stop and its nonce travels on the POST, so
 * the proxy does not restore shared client config while a Task Scheduler wrapper can still
 * relaunch it. The caller discharges the receipt only after Part B and its own restore
 * succeeded; otherwise it stays on disk for recovery.
 *
 * A Part A that did not end stopped/absent still gets the graceful POST — the proxy may be
 * running and a graceful stop is always preferable — but never the forced fallback: a
 * `taskkill /T /F` under a manager that would not stop is the one outcome the checked stop
 * exists to prevent.
 */
import { claimPendingTeardown, type PendingTeardownPartA } from "../config/pending-teardown";
import { readRuntimePort } from "../config/process-state";
import type { GracefulStopIo } from "../lib/process-control";

export interface UninstallProxyStopIo {
  platform: NodeJS.Platform;
  /** Detailed Part A outcome, or null when the service-stop step threw. */
  serviceStop: "absent" | "stopped" | "stopped-respawnable" | "failed" | "state-unknown" | null;
  readPid: () => number | null;
  findLiveProxy: () => Promise<{ pid?: number | null; port: number; hostname?: string } | null>;
  /** Tri-state proof that nothing answers on any endpoint this home could serve. */
  endpointProvenDown: () => Promise<boolean>;
  /** The Part A record the receipt carries, so /api/stop skips a second Part A. */
  partARecord?: () => PendingTeardownPartA | null;
  claim?: (
    endpoint: { hostname: string; port: number },
    source: "exact" | "guessed",
    ownerPid: number,
    handover: "update-restart" | undefined,
    partA: PendingTeardownPartA | null,
  ) => { nonce: string };
  /** The tracked target's own runtime record; null when there is none for that pid. */
  runtimeEndpointFor?: (pid: number) => { hostname: string; port: number } | null;
  stop: (pid: number, io: GracefulStopIo) => Promise<boolean>;
  removeTracked: (pid: number) => void;
  /** Whether Part B owns the Windows port wait (#7771). */
  portWaitOwned: () => boolean;
}

export interface UninstallProxyStopResult {
  changed: boolean;
  provenDown: boolean;
  /** The deferred-teardown receipt this step claimed, for the caller to discharge. */
  nonce?: string;
}

/** The runtime record a tracked pid wrote, which is the only exact endpoint it can be reached on. */
function trackedRuntimeEndpoint(pid: number): { hostname: string; port: number } | null {
  const runtime = readRuntimePort(pid);
  return runtime?.port ? { hostname: runtime.hostname ?? "127.0.0.1", port: runtime.port } : null;
}

export async function stopUninstallProxy(io: UninstallProxyStopIo): Promise<UninstallProxyStopResult> {
  const windows = io.platform === "win32";
  // Part A not stopped/absent means a manager may still be running and could respawn the
  // proxy. The graceful POST is still worth sending; the forced fallback is not.
  const partAProven = io.serviceStop === "stopped" || io.serviceStop === "stopped-respawnable" || io.serviceStop === "absent";
  const forbidForcedFallback = windows && !partAProven;
  // An unconfirmed stop normally still leaves this step's proof to the respawn window that
  // follows. With the forced ladder forbidden it must not: the process may be alive, and the
  // Part A failure the caller already recorded is what keeps shared config up.
  //
  // An unconfirmed stop is also NOT evidence that this home's proxy is down. `stopProxy`
  // answers false without contacting the endpoint when the tracked pid is already dead, so
  // "the tracked proxy is gone" and "nothing else is serving on this home's ports" are two
  // different claims; Part A saying `absent`/`stopped` covers only the manager it saw. A
  // different proxy on the configured port would otherwise be missed, and shared config
  // restored under it (#3008). The tri-state probe the discovery path already requires is
  // what settles it, and only a definitive "nothing answers anywhere" keeps the proof.
  const confirmed = async (stopped: boolean): Promise<boolean> => {
    // A confirmed stop proves the tracked proxy down, nothing more. After an "absent" Part A on
    // Windows no Part B follows, so a second proxy on another candidate endpoint would go
    // unseen and shared config would be restored under it (#3008): every candidate has to
    // answer definitively dead. After "stopped", Part B confirms the port instead.
    if (stopped) return !(windows && io.serviceStop === "absent") || await io.endpointProvenDown();
    if (forbidForcedFallback) return false;
    return await io.endpointProvenDown();
  };

  // Resolve the target BEFORE anything is recorded. The receipt is an obligation on a
  // specific address, so claiming it from a runtime record the stop never contacts — or
  // before knowing whether a stop will happen at all — writes a promise nobody can
  // discharge: recovery probes exactly the endpoint the receipt names.
  let target: { pid: number; tracked: boolean; endpoint: { hostname: string; port: number } | null };
  const pid = io.readPid();
  if (pid) {
    target = { pid, tracked: true, endpoint: (io.runtimeEndpointFor ?? trackedRuntimeEndpoint)(pid) };
  } else {
    // A missing pid file is not proof that nothing is serving: a proxy can outlive its
    // record (crash, manual delete, corrupt file), which is exactly why `ocx stop` falls
    // back to identity-checked discovery. Without this, uninstall restored shared config
    // and reported success while that proxy kept running (#3008).
    const live = await io.findLiveProxy();
    if (!live) {
      // A miss is not proof: `findLiveProxy` collapses a timeout and a transport failure
      // into the same null as a dead endpoint. Ask the tri-state probe, which only says
      // "dead" for a refused connection or a definitive non-OpenCodex answer (#3008).
      const provenDown = await io.endpointProvenDown();
      if (!provenDown) {
        throw new Error("no proxy could be found, but its endpoint could not be confirmed down either; confirm nothing is serving, then rerun");
      }
      // Nothing will be stopped, so nothing may be deferred.
      return { changed: false, provenDown };
    }
    if (!live.pid) {
      throw new Error(`a proxy is answering on port ${live.port} but no process id could be resolved for it; stop it from the home that started it, then rerun`);
    }
    // A discovered proxy answers where discovery found it, which is the only address a stop
    // can reach it on — not whatever a stale runtime record happens to say.
    target = { pid: live.pid, tracked: false, endpoint: { hostname: live.hostname ?? "127.0.0.1", port: live.port } };
  }
  // A receipt exists to carry a deferred teardown across the POST. Without an exact endpoint
  // there is no POST to defer: `stopProxy` falls to its own path, and a "guessed" receipt
  // would name an address no stop contacted while recovery then refuses to finish it.
  let nonce: string | undefined;
  if (windows && target.endpoint) {
    try {
      nonce = (io.claim ?? claimPendingTeardown)(target.endpoint, "exact", process.pid, undefined, (io.partARecord ?? (() => null))()).nonce;
    } catch (error) {
      // Without the receipt the proxy performs its own teardown during the stop, which is
      // the pre-#3008 behaviour — and on Windows a wrapper can relaunch it afterwards, so
      // client config would already be restored under a live proxy. Refuse instead.
      throw new Error(
        "the deferred-teardown receipt could not be recorded, so the proxy was left running: "
        + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  const stopIo: GracefulStopIo = {
    skipPortWait: io.portWaitOwned(),
    ...(nonce ? { deferSharedTeardownNonce: nonce } : {}),
    ...(forbidForcedFallback ? { allowForcedFallback: false } : {}),
    // The same endpoint the receipt names, so the POST and the obligation cannot diverge.
    ...(target.endpoint ? { runtimeEndpoint: target.endpoint } : {}),
  };
  const provenDown = await confirmed(await io.stop(target.pid, stopIo));
  // Only a proven stop cleared the record it names. Removing it after a POST that timed out
  // drops the only pointer to a process that may still be running, and reporting the step as
  // changed would claim a state that was never observed. `provenDown` is how the caller
  // learns it must record the failure (it keeps the shared teardown up).
  if (target.tracked && provenDown) io.removeTracked(target.pid);
  return { changed: target.tracked ? provenDown : true, provenDown, ...(nonce ? { nonce } : {}) };
}
