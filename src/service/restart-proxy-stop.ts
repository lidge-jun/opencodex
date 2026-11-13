import { claimPendingTeardown, clearPendingTeardown } from "../config/pending-teardown";
import { readRuntimePort, verifyPidIdentity } from "../config/process-state";
import { gracefulStopHost, ProxyOwnershipRefusedError, stopProxy } from "../lib/process-control";
import { proveLiveProxyOwnedByHome, SERVICE_STOP_LIVENESS } from "../server/proxy-liveness";

export type RestartStopEndpoint = { hostname: string; port: number };

/** A deferred-teardown receipt a restart keeps until a replacement serves its endpoint. */
export type HeldRestartReceipt = { nonce: string; pid: number; endpoint: RestartStopEndpoint };

export interface RestartProxyStopDeps {
  readRuntime?: (pid: number) => { port: number; hostname?: string } | null;
  /** Fresh proof that `pid` serves `endpoint` with this home's runtime attestation secret. */
  prove?: (pid: number, endpoint: RestartStopEndpoint) => Promise<boolean>;
  /** Writes the pending-teardown receipt and returns its nonce. */
  claim?: (endpoint: RestartStopEndpoint) => string;
  clear?: (nonce: string) => boolean;
  stop?: typeof stopProxy;
  /** Identity check rechecked before any forced stop (verifyPidIdentity). */
  verify?: (pid: number) => number | null;
}

/**
 * Stop a home-verified proxy for `ocx service restart` (#8416).
 *
 * A restart keeps its Task Scheduler task registered, so a bare POST /api/stop is answered with
 * 409 respawnable_service: the proxy cannot verify, after it has exited, that no wrapper brings it
 * back. The restart does verify that window itself (proxyStillLiveAfterStop), which is the contract
 * a pending-teardown receipt carries for `ocx stop` (#3008). With a valid receipt for its own port
 * named in the request, the route skips that refusal, defers its shared teardown, and the proxy
 * exits keeping client routing for the replacement, as a service-managed crash and respawn does.
 *
 * The request carries this home's admin token, so it goes only to the endpoint this home's runtime
 * record names for `pid`, and only after that listener proves possession of the record's
 * attestation secret for a fresh challenge. A process that merely claims the pid in an unattested
 * /healthz is never sent the token or stopped. Without a record or a proof, nothing is claimed or
 * sent and the stop refuses; the caller then keeps whatever supervises that process.
 *
 * The receipt is written before the request and is an obligation: client routing still points at
 * the stopped proxy's endpoint. Only a refusal proves nothing was deferred, so only a refusal
 * releases it here (and is never forced; stopProxy throws it). Every other outcome, an accepted
 * stop, an unanswered request that fell back to the kill ladder, or a failure on the way, hands
 * the receipt to `hold`. The caller releases it once a replacement serves that endpoint; until
 * then, a restart that fails or dies leaves it for the next `ocx stop` to finish.
 */
export async function stopProxyForServiceRestart(
  pid: number,
  hold: (receipt: HeldRestartReceipt) => void,
  deps: RestartProxyStopDeps = {},
): Promise<boolean> {
  const runtime = (deps.readRuntime ?? readRuntimePort)(pid);
  if (!runtime?.port) {
    throw new Error(`No runtime record of this home names proxy ${pid}, so its endpoint could not be proven; it was not stopped.`);
  }
  // The host the stop request will use (gracefulStopHost), so the proof is made against the very
  // destination the admin token is then sent to, not a name that could resolve elsewhere.
  const endpoint = { hostname: gracefulStopHost(runtime.hostname), port: runtime.port };
  const proven = await (deps.prove ?? (async (target: number, at: RestartStopEndpoint) =>
    await proveLiveProxyOwnedByHome({ pid: target, port: at.port, hostname: at.hostname, probeHostname: at.hostname, source: "runtime" }, SERVICE_STOP_LIVENESS) === "proven"))(pid, endpoint);
  if (!proven) {
    throw new Error(`Proxy ${pid} could not prove it serves this home's endpoint ${endpoint.hostname}:${endpoint.port}; this home's admin token was not sent to it and it was not stopped.`);
  }
  const nonce = (deps.claim ?? (target => claimPendingTeardown(target, "exact").nonce))(endpoint);
  try {
    const verify = deps.verify ?? verifyPidIdentity;
    const stopped = await (deps.stop ?? stopProxy)(pid, {
      deferSharedTeardownNonce: nonce, runtimeEndpoint: endpoint, runtimeEndpointOnly: true,
      // The kill fallback only after the graceful request went unanswered, and only while pid is
      // still the ocx start process this restart verified.
      mayTerminate: () => verify(pid) === pid,
    });
    hold({ nonce, pid, endpoint });
    return stopped;
  } catch (error) {
    if (error instanceof ProxyOwnershipRefusedError) (deps.clear ?? clearPendingTeardown)(nonce);
    else hold({ nonce, pid, endpoint });
    throw error;
  }
}
