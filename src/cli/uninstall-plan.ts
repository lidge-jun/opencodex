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
  /** Did the proxy step finish with nothing left running that we know of? */
  proxyAccountedFor: boolean;
  /** Did service removal complete (or find nothing to remove)? */
  serviceRemoved: boolean;
};

export function sharedTeardownAuthorized(o: UninstallObservation): boolean {
  if (o.serviceStop === null) return false;
  // "absent" and a clean stop are the only service states that prove nothing is managing
  // the proxy. `stopped-respawnable` is fine here because uninstall REMOVES the manager
  // next, which is what makes the wrapper unable to come back.
  if (o.serviceStop === "failed" || o.serviceStop === "state-unknown") return false;
  return o.proxyAccountedFor && o.serviceRemoved;
}
