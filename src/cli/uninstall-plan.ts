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
   * Was the restart window verified AFTER removal? Needed after an older CLI's
   * `stopped-respawnable` and, on Windows, after every `stopped`: there it is Part B of the
   * checked stop (#7771), which proves the port stays free and no wrapper came back.
   *
   * Deleting the registration does not prove an already-running `:loop` wrapper died —
   * `ocx stop` confirms across the window; uninstall has to do the same before it may take
   * shared config down (#764).
   */
  respawnWindowVerified: boolean;
};

/** Whether the restart window must be verified before shared config may come down. */
export function respawnWindowRequired(
  o: Pick<UninstallObservation, "serviceStop">,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return o.serviceStop === "stopped-respawnable" || (platform === "win32" && o.serviceStop === "stopped");
}

/**
 * Whether the uninstall may remove the installed manager.
 *
 * On Windows the removal deletes a Task Scheduler registration and stops/deletes a WinSW
 * service. Both are only safe once Part A proved the manager stopped or that none is
 * registered: `ocx service uninstall` refuses in the same states, and removing the
 * registration of a manager that could not be stopped hides the reason the proxy may
 * come back instead of fixing it. Other platforms remove after their own stop attempt, as
 * before.
 */
export function serviceRemovalAllowed(
  o: Pick<UninstallObservation, "serviceStop">,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return true;
  return o.serviceStop === "stopped" || o.serviceStop === "absent";
}

export function sharedTeardownAuthorized(o: UninstallObservation, platform: NodeJS.Platform = process.platform): boolean {
  if (o.serviceStop === null) return false;
  // "absent" and a clean stop are the only service states that prove nothing is managing
  // the proxy.
  if (o.serviceStop === "failed" || o.serviceStop === "state-unknown") return false;
  // Removing the registration is not the same as proving the running wrapper is gone.
  if (respawnWindowRequired(o, platform) && !o.respawnWindowVerified) return false;
  if (o.serviceRemoval === null || o.serviceRemoval === "failed") return false;
  return o.proxyProvenDown;
}

/**
 * The "service removed" step: gate, then remove.
 *
 * Kept beside the rule so the command body stays a call, and so the refusal is testable
 * without reading `handleUninstall`. A refused gate throws, which the step records as a
 * failure and which keeps the shared teardown blocked.
 */
export function uninstallServiceRemoval(
  o: Pick<UninstallObservation, "serviceStop">,
  remove: () => "absent" | "removed" | "failed",
  platform: NodeJS.Platform = process.platform,
): "absent" | "removed" | "failed" {
  if (!serviceRemovalAllowed(o, platform)) {
    throw new Error(
      "the service manager could not be proven stopped, so its registration was left in place; "
      + "resolve the 'service stopped' failure, then rerun 'ocx uninstall'",
    );
  }
  return remove();
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

export async function everyEndpointProvenDownAsync(
  endpoints: readonly ProbeEndpoint[],
  probe: (e: ProbeEndpoint) => Promise<"live" | "dead" | "unknown"> | "live" | "dead" | "unknown",
): Promise<boolean> {
  if (endpoints.length === 0) return false;
  const results = await Promise.all(endpoints.map(e => probe(e)));
  return results.every(result => result === "dead");
}

/**
 * The uninstall's "nothing answers on any endpoint this home could serve" proof, with the
 * candidate set captured NOW. The proxy stop removes the runtime record (and a stopped proxy
 * may remove its own), so a set read after the stop would silently drop the stopped proxy's
 * port. Every candidate, not just the preferred one: a stale runtime record pointing at a
 * closed port would otherwise "prove" a live proxy on the configured port is gone. Any
 * failure to read or probe is not proof.
 */
export function captureUninstallEndpointProof(
  readCandidates: () => ProbeEndpoint[],
  probe: (e: ProbeEndpoint) => Promise<"live" | "dead" | "unknown"> | "live" | "dead" | "unknown",
): () => Promise<boolean> {
  let candidates: ProbeEndpoint[] | null = null;
  try { candidates = readCandidates(); } catch { candidates = null; }
  return async () => {
    try {
      return candidates !== null && await everyEndpointProvenDownAsync(candidates, probe);
    } catch {
      return false;
    }
  };
}
