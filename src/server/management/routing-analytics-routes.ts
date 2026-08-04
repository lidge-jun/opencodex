/**
 * Routing analytics API (RI-03): `GET /api/routing-analytics`.
 *
 * Returns source-backed reliability/latency/cost metrics over the
 * request-history index. Read-only; never changes routing behavior.
 */

import { computeRoutingAnalytics } from "../../routing/analytics";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

function parseOptionalInt(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw.trim());
  return Number.isInteger(value) ? value : undefined;
}

export async function handleRoutingAnalyticsRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { url, req, config } = ctx;
  if (url.pathname !== "/api/routing-analytics" || req.method !== "GET") return null;

  const from = parseOptionalInt(url.searchParams.get("from"));
  const to = parseOptionalInt(url.searchParams.get("to"));
  if (from !== undefined && to !== undefined && from > to) {
    return jsonResponse({ error: { code: "invalid_range", message: "from must not be after to" } }, 400, req, config);
  }

  const result = await computeRoutingAnalytics({
    provider: url.searchParams.get("provider")?.trim() || undefined,
    model: url.searchParams.get("model")?.trim() || undefined,
    profileId: url.searchParams.get("profileId")?.trim() || undefined,
    surface: url.searchParams.get("surface")?.trim() || undefined,
    from,
    to,
  });
  return jsonResponse(result, 200, req, config);
}
