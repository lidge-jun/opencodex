import type { ManagementContext } from "./context";
import { hasHumanDashboardSession } from "./consent-session";

/**
 * Desktop compatibility mutations require an operator-mediated browser session. A remembered
 * device session derives from the admin token, so it does not count as that confirmation.
 */
export function isAuthorizedDesktopCompatibilityMutation(ctx: ManagementContext): boolean {
  return hasHumanDashboardSession(ctx)
    && ctx.trustedLoopbackIngress
    && ctx.sessionControl?.isPaired(ctx.req, ctx.config) === true;
}
