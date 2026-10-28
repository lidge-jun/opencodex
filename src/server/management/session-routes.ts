import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

export function handleSessionRoutes(ctx: ManagementContext): Response | null {
  if (ctx.url.pathname === "/api/session/remember" && ctx.req.method === "POST") {
    if (ctx.principal !== "admin-token") return jsonResponse({ error: "Admin token required" }, 403, ctx.req, ctx.config);
    try {
      const remembered = ctx.sessionControl?.rememberDevice?.(ctx.req, ctx.config);
      if (!remembered) return jsonResponse({ error: "Remember requires a direct HTTPS dashboard (or loopback) and matching Origin" }, 403, ctx.req, ctx.config);
      const response = jsonResponse({ session: remembered.session, device: remembered.device }, 200, ctx.req, ctx.config);
      response.headers.set("Set-Cookie", remembered.cookie);
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch { return jsonResponse({ error: "Could not persist dashboard session" }, 503, ctx.req, ctx.config); }
  }
  if (ctx.url.pathname !== "/api/session/logout" || ctx.req.method !== "POST") return null;
  if (ctx.principal !== "gui-session") {
    return jsonResponse({ error: "GUI session required" }, 403, ctx.req, ctx.config);
  }
  let expiredCookie: string | null | undefined;
  try { expiredCookie = ctx.sessionControl?.forgetDevice?.(ctx.req, ctx.config); }
  catch { return jsonResponse({ error: "Could not forget dashboard session" }, 503, ctx.req, ctx.config); }
  // Forget may already have revoked every short-lived session belonging to this device.
  if (!ctx.sessionControl?.revokeCurrent(ctx.req) && !expiredCookie) {
    return jsonResponse({ error: "GUI session not found" }, 401, ctx.req, ctx.config);
  }
  const response = jsonResponse({ ok: true }, 200, ctx.req, ctx.config);
  if (expiredCookie) response.headers.set("Set-Cookie", expiredCookie);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
