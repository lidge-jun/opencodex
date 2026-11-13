import { claimPendingTeardown, clearPendingTeardown, pendingTeardownPathFor } from "../config/pending-teardown";
import { readRuntimePort } from "../config/process-state";
import { stopProxy } from "../lib/process-control";

export type RestartStopEndpoint = { hostname: string; port: number };

export interface RestartProxyStopDeps {
  readRuntime?: (pid: number) => { port: number; hostname?: string } | null;
  /** Writes the pending-teardown receipt and returns its nonce. */
  claim?: (endpoint: RestartStopEndpoint) => string;
  clear?: (nonce: string) => boolean;
  stop?: typeof stopProxy;
  warn?: (message: string) => void;
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
 * The receipt is written before the request, so a restart that dies mid-stop leaves a durable
 * obligation the next `ocx stop` finishes. Once the request is answered the restart releases it:
 * the proxy either exited keeping routing for the replacement this restart is about to start, or
 * refused and still owns its own teardown. A refusal is never forced; stopProxy throws it. Without
 * an exact endpoint no request is sent, so no receipt is written and the verified-pid stop runs as
 * before.
 */
export async function stopProxyForServiceRestart(
  pid: number,
  discovered: RestartStopEndpoint | null = null,
  deps: RestartProxyStopDeps = {},
): Promise<boolean> {
  const stop = deps.stop ?? stopProxy;
  const runtime = (deps.readRuntime ?? readRuntimePort)(pid);
  const endpoint = discovered ?? (runtime?.port ? { hostname: runtime.hostname ?? "127.0.0.1", port: runtime.port } : null);
  if (!endpoint) return stop(pid);
  const nonce = (deps.claim ?? (target => claimPendingTeardown(target, "exact").nonce))(endpoint);
  try {
    return await stop(pid, { deferSharedTeardownNonce: nonce, runtimeEndpoint: endpoint });
  } finally {
    if (!(deps.clear ?? clearPendingTeardown)(nonce)) {
      (deps.warn ?? console.warn)(`⚠️  Could not remove the restart's teardown receipt ${pendingTeardownPathFor(nonce)}; the next 'ocx stop' finishes it.`);
    }
  }
}
