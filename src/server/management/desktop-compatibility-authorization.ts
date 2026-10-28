import type { ManagementContext } from "./context";

/** Desktop compatibility mutations require an operator-mediated browser session. */
export function isAuthorizedDesktopCompatibilityMutation(ctx: ManagementContext): boolean {
  return ctx.principal === "gui-session"
    && ctx.trustedLoopbackIngress
    && ctx.sessionControl?.isPaired(ctx.req, ctx.config) === true;
}
