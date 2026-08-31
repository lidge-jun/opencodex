/**
 * Whether an uninstall may take shared client config down (#3008).
 *
 * Extracted from `handleUninstall` because the rule is a decision, and a decision that
 * only exists inside a long imperative command can only be tested by reading its source —
 * which is how this shipped wrong twice: first trusting a boolean that collapsed "not
 * installed" with "still running", then trusting a missing pid file as proof no proxy was
 * serving.
 *
 * Native Codex and the Grok fence are SHARED. Restoring them while something may still be
 * serving leaves the client and the proxy pointing at each other, so every step that could
 * leave a live proxy behind has to be accounted for first.
 */
export type UninstallObservation = {
  /** Detailed service-stop outcome, or null when the step threw. */
  serviceStop: "absent" | "stopped" | "stopped-respawnable" | "failed" | "state-unknown" | null;
  /**
   * Did the proxy step PROVE nothing is serving?
   *
   * A `findLiveProxy` miss is not that proof: it collapses a timeout and a transport
   * failure into the same null as a dead endpoint, so an unresponsive proxy read as absent.
   */
  proxyProvenDown: boolean;
  /** Service removal outcome, or null when the step threw. */
  serviceRemoval: "absent" | "removed" | "failed" | null;
  /**
   * For a Task Scheduler backend: was the restart window verified AFTER removal?
   *
   * Deleting the registration does not prove an already-running `:loop` wrapper died —
   * killing it is best-effort (#764). `ocx stop` polls across the window; uninstall has
   * to do the same before it may take shared config down.
   */
  respawnWindowVerified: boolean;
};

export function sharedTeardownAuthorized(o: UninstallObservation): boolean {
  if (o.serviceStop === null) return false;
  // "absent" and a clean stop are the only service states that prove nothing is managing
  // the proxy.
  if (o.serviceStop === "failed" || o.serviceStop === "state-unknown") return false;
  // Removing the registration is not the same as proving the running wrapper is gone.
  if (o.serviceStop === "stopped-respawnable" && !o.respawnWindowVerified) return false;
  if (o.serviceRemoval === null || o.serviceRemoval === "failed") return false;
  return o.proxyProvenDown;
}

/** An endpoint an uninstall must account for before shared config comes down. */
export type ProbeEndpoint = { hostname: string; port: number };

/**
 * Every DISTINCT endpoint this home could be serving on.
 *
 * A runtime record and the configured port can disagree — a stale record pointing at a
 * closed port while the live proxy sits on the configured one. Probing only the runtime
 * candidate then reports "dead" for a port nobody is using and authorizes the teardown
 * (#3008). `findLiveProxy` already probes both; the proof has to cover both too.
 */
export function endpointsToProve(
  runtime: { port?: number; hostname?: string } | null,
  config: { port?: number; hostname?: string },
): ProbeEndpoint[] {
  const out: ProbeEndpoint[] = [];
  const push = (port: number | undefined, hostname: string | undefined) => {
    if (!port || port <= 0 || port > 65535) return;
    const endpoint = { hostname: hostname ?? "127.0.0.1", port };
    if (out.some(e => e.port === endpoint.port && e.hostname === endpoint.hostname)) return;
    out.push(endpoint);
  };
  push(runtime?.port, runtime?.hostname);
  push(typeof config.port === "number" && config.port > 0 ? config.port : 10100, config.hostname);
  return out;
}

/**
 * Proof requires EVERY candidate to be definitively dead.
 *
 * "unknown" is not absence: a listener that accepts connections but withholds /healthz, or
 * one that times out, is exactly the state where restoring shared config is most harmful.
 */
export function everyEndpointProvenDown(
  endpoints: readonly ProbeEndpoint[],
  probe: (e: ProbeEndpoint) => "live" | "dead" | "unknown",
): boolean {
  if (endpoints.length === 0) return false;
  return endpoints.every(e => probe(e) === "dead");
}
