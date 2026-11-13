import { claimPendingTeardown, clearPendingTeardown } from "../config/pending-teardown";
import { readRuntimePort } from "../config/process-state";
import { ProxyOwnershipRefusedError, stopProxy } from "../lib/process-control";

export type RestartStopEndpoint = { hostname: string; port: number };

/** A deferred-teardown receipt a restart keeps until a replacement serves its endpoint. */
export type HeldRestartReceipt = { nonce: string; pid: number; endpoint: RestartStopEndpoint };

export interface RestartProxyStopDeps {
  readRuntime?: (pid: number) => { port: number; hostname?: string } | null;
  /** Writes the pending-teardown receipt and returns its nonce. */
  claim?: (endpoint: RestartStopEndpoint) => string;
  clear?: (nonce: string) => boolean;
  stop?: typeof stopProxy;
}

/**
 * Stop a home-verified proxy for `ocx service restart` (#8416).
 *
 * A restart keeps its Task Scheduler task registered, so a bare POST /api/stop is answered with
 * 409 respawnable_service: the proxy cannot verify, after it has exited, that no wrapper brings it
 * back. The restart does verify that window itself (proxyStillLiveAfterStop), which is the contract
 * a pending-teardown receipt carries for `ocx stop` (#3008). With a valid receipt named in the
 * request, the route skips that refusal, defers its shared teardown, and the proxy exits keeping
 * client routing for the replacement, as a service-managed crash and respawn already does.
 *
 * The receipt is written before the request and is an obligation: client routing still points at
 * the stopped proxy's endpoint. Only a refusal proves nothing was deferred, so only a refusal
 * releases it here (and is never forced; stopProxy throws it). Every other outcome, an accepted
 * stop, an unanswered request that fell back to the kill ladder, or a failure on the way, hands
 * the receipt to `hold`. The caller releases it once a replacement serves; until then, a restart
 * that fails or dies leaves it for the next `ocx stop` to finish. Without an exact endpoint no
 * request is sent, so no receipt is written and the verified-pid stop runs as before.
 */
export async function stopProxyForServiceRestart(
  pid: number,
  discovered: RestartStopEndpoint | null,
  hold: (receipt: HeldRestartReceipt) => void,
  deps: RestartProxyStopDeps = {},
): Promise<boolean> {
  const stop = deps.stop ?? stopProxy;
  const runtime = (deps.readRuntime ?? readRuntimePort)(pid);
  const endpoint = discovered ?? (runtime?.port ? { hostname: runtime.hostname ?? "127.0.0.1", port: runtime.port } : null);
  if (!endpoint) return stop(pid);
  const nonce = (deps.claim ?? (target => claimPendingTeardown(target, "exact").nonce))(endpoint);
  try {
    const stopped = await stop(pid, { deferSharedTeardownNonce: nonce, runtimeEndpoint: endpoint });
    hold({ nonce, pid, endpoint });
    return stopped;
  } catch (error) {
    if (error instanceof ProxyOwnershipRefusedError) (deps.clear ?? clearPendingTeardown)(nonce);
    else hold({ nonce, pid, endpoint });
    throw error;
  }
}
