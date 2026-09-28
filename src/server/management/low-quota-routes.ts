/** Auth is enforced by the management dispatcher before this lazy route runs. */
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

export async function handleLowQuotaRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { url, req, config } = ctx;
  if (url.pathname !== "/api/codex-auth/low-quota-events" || req.method !== "GET") return null;
  const raw = url.searchParams.get("limit");
  if (raw !== null && (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)))) {
    return jsonResponse({ error: { code: "invalid_limit", message: "limit must be a non-negative integer" } }, 400, req, config);
  }
  const limit = raw === null ? 20 : Math.min(100, Number(raw));
  return jsonResponse({ events: ctx.deps.listLowQuotaEvents?.(limit) ?? [] }, 200, req, config);
}
