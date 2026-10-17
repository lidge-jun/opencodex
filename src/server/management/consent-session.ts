import type { ManagementContext } from "./context";

/** Remembered sessions derive from the admin token, so casual-path consent guards give them admin-token parity. */
export function hasHumanDashboardSession(ctx: Pick<ManagementContext, "principal" | "guiSessionIssuance">): boolean {
  return ctx.principal === "gui-session" && ctx.guiSessionIssuance !== "remembered-admin";
}
