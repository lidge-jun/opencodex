/**
 * Routing analytics API (RI-03): `GET /api/routing-analytics`.
 *
 * Returns source-backed reliability/latency/cost metrics over the
 * request-history index. Read-only; never changes routing behavior.
 */

import { computeRoutingAnalytics } from "../../routing/analytics";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

function parseQueryInt(raw: string | null): number | undefined | "invalid" {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "invalid";
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : "invalid";
}

export async function handleRoutingAnalyticsRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { url, req, config } = ctx;
  if (url.pathname !== "/api/routing-analytics" || req.method !== "GET") return null;

  const fromParsed = parseQueryInt(url.searchParams.get("from"));
  if (fromParsed === "invalid") {
    return jsonResponse({ error: { code: "invalid_from", message: "from must be an integer timestamp" } }, 400, req, config);
  }
  const toParsed = parseQueryInt(url.searchParams.get("to"));
  if (toParsed === "invalid") {
    return jsonResponse({ error: { code: "invalid_to", message: "to must be an integer timestamp" } }, 400, req, config);
  }
  const from = fromParsed;
  const to = toParsed;
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
