/**
 * `GET /api/quota-pool`: the `ocx.quota-pool/1` read GOAT consumes (see src/quota-pool/).
 *
 * Same management authorization as the neighbouring reads; a Remote Link Child reaches it through
 * the read-only link relay (`LINK_MANAGEMENT_READ_PATHS`) and a Hub client through its hub relay.
 * The read is always passive: there is no refresh form, so nothing here can make the Home probe.
 */
import type { ManagementContext } from "./context";
import { jsonResponse } from "../auth-cors";

export async function handleQuotaPoolRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  // Any query (including a stray refresh=1) is ignored: the read has no active form.
  if (url.pathname === "/api/quota-pool" && req.method === "GET") {
    const { readQuotaPool } = await import("../../quota-pool/assemble");
    const result = await readQuotaPool(config);
    const response = result.ok
      ? jsonResponse(result.pool, 200, req, config)
      : jsonResponse({ error: result.error }, 503, req, config);
    response.headers.set("cache-control", "no-store");
    return response;
  }
  return null;
}
