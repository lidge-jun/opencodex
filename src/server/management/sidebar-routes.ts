/**
 * GET /api/update/badge — the cheap poll behind the sidebar update control.
 *
 * Rides the standard management gate (auth + origin check happen before
 * dispatch) and is scalar-only: version strings and booleans. No npm output,
 * install path, or command text is serialized here.
 */
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

export async function handleSidebarRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;

  if (url.pathname === "/api/update/badge" && req.method === "GET") {
    const { readUpdateBadge } = await import("../../update/badge");
    return jsonResponse(readUpdateBadge());
  }

  return null;
}
