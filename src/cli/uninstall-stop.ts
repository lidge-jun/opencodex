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
import { loadConfig } from "../config";
import { claimPendingTeardown, type PendingTeardownPartA } from "../config/pending-teardown";
import { readRuntimePort } from "../config/process-state";
import type { GracefulStopIo } from "../lib/process-control";

export interface UninstallProxyStopIo {
  platform: NodeJS.Platform;
  /** Detailed Part A outcome, or null when the service-stop step threw. */
  serviceStop: "absent" | "stopped" | "stopped-respawnable" | "failed" | "state-unknown" | null;
  readPid: () => number | null;
  findLiveProxy: () => Promise<{ pid?: number | null; port: number } | null>;
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
  receiptEndpoint?: () => { endpoint: { hostname: string; port: number }; source: "exact" | "guessed" };
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

/** The endpoint a receipt records: the runtime record when there is one, else the config. */
function defaultReceiptEndpoint(): { endpoint: { hostname: string; port: number }; source: "exact" | "guessed" } {
  const runtime = readRuntimePort();
  if (runtime?.port) return { endpoint: { hostname: runtime.hostname ?? "127.0.0.1", port: runtime.port }, source: "exact" };
  try {
    const config = loadConfig();
    return {
      endpoint: { hostname: config.hostname ?? "127.0.0.1", port: typeof config.port === "number" && config.port > 0 ? config.port : 10100 },
      source: "guessed",
    };
  } catch {
    return { endpoint: { hostname: "127.0.0.1", port: 10100 }, source: "guessed" };
  }
}

export async function stopUninstallProxy(io: UninstallProxyStopIo): Promise<UninstallProxyStopResult> {
  const windows = io.platform === "win32";
  // Part A not stopped/absent means a manager may still be running and could respawn the
  // proxy. The graceful POST is still worth sending; the forced fallback is not.
  const partAProven = io.serviceStop === "stopped" || io.serviceStop === "stopped-respawnable" || io.serviceStop === "absent";
  let nonce: string | undefined;
  if (windows) {
    const { endpoint, source } = (io.receiptEndpoint ?? defaultReceiptEndpoint)();
    try {
      nonce = (io.claim ?? claimPendingTeardown)(endpoint, source, process.pid, undefined, (io.partARecord ?? (() => null))()).nonce;
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
  const forbidForcedFallback = windows && !partAProven;
  const stopIo: GracefulStopIo = {
    skipPortWait: io.portWaitOwned(),
    ...(nonce ? { deferSharedTeardownNonce: nonce } : {}),
    ...(forbidForcedFallback ? { allowForcedFallback: false } : {}),
  };
  // An unconfirmed stop normally still leaves this step's proof to the respawn window that
  // follows. With the forced ladder forbidden it must not: the process may be alive, and the
  // Part A failure the caller already recorded is what keeps shared config up.
  const confirmed = (stopped: boolean): boolean => stopped || !forbidForcedFallback;
  const pid = io.readPid();
  if (!pid) {
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
      return { changed: false, provenDown, ...(nonce ? { nonce } : {}) };
    }
    if (!live.pid) {
      throw new Error(`a proxy is answering on port ${live.port} but no process id could be resolved for it; stop it from the home that started it, then rerun`);
    }
    return { changed: true, provenDown: confirmed(await io.stop(live.pid, stopIo)), ...(nonce ? { nonce } : {}) };
  }
  const provenDown = confirmed(await io.stop(pid, stopIo));
  io.removeTracked(pid);
  return { changed: true, provenDown, ...(nonce ? { nonce } : {}) };
}
