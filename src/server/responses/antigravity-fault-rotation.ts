import { isAutomaticReplayBlocked } from "../../lib/upstream-retry";

/**
 * Whether an Antigravity 502/503/504 that outlived the same-account transient ladder may be
 * replayed once on a live sibling. The failing account is cooled briefly (not marked), and the
 * per-request `attempted` flag keeps a pool-wide outage to one extra ladder per request.
 *
 * The recovery loop asks this for the response it is holding and again for the response a 429
 * account hop or a verify-account 403 hop just produced: that hop's replacement can be the 5xx, and
 * without asking here the hop loop would leave recovery with the one-hop fault rotation still unspent.
 */
export function isAntigravityFaultRotatable(
  providerName: string,
  response: Response,
  state: { activeAdapter: { name: string }; genericFailovers: number; genericFailoverLimit: number },
  poolActivated: boolean,
  faultRotationAttempted: boolean,
): boolean {
  return providerName === "google-antigravity" && [502, 503, 504].includes(response.status)
    && state.activeAdapter.name === "google"
    && poolActivated && !faultRotationAttempted
    // A header-only hold forbids this resend even without proxy-owned refusal provenance.
    && !isAutomaticReplayBlocked(response)
    && state.genericFailovers < state.genericFailoverLimit;
}
