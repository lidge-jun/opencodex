import type { LabRouteContext } from "../live/types";
import type { ResolvedPolicyRouteSubject } from "../../routing/compatibility/subject";

/** Harness features the production trusted-route automation contract actually provides. */
export const CL08_TRUSTED_LIVE_HARNESS_FEATURES = Object.freeze([
  "live_transport",
]);

/** Build the CL-03 route context automation dispatch and planning share. */
export function buildAutomationLiveRouteContext(
  resolved: ResolvedPolicyRouteSubject,
  allowPrivateNetwork = false,
): LabRouteContext {
  return {
    ...resolved.routeContext,
    labRunApproval: true,
    allowPrivateNetwork,
    requiredClaims: resolved.routeContext.requiredClaims ?? [],
    availableHarnessFeatures: [...CL08_TRUSTED_LIVE_HARNESS_FEATURES],
  };
}
