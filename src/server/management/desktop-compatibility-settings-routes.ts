import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";

const PATH = "/api/codex/desktop-compatibility/settings";
export async function handleDesktopCompatibilitySettingsRoutes(ctx: ManagementContext): Promise<Response | null> {
  if (ctx.url.pathname !== PATH) return null;
  if (ctx.req.method !== "GET" && ctx.req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  if (ctx.req.method === "POST" && (ctx.principal !== "gui-session" || !ctx.trustedLoopbackIngress)) return jsonResponse({ error: "local_dashboard_confirmation_required" }, 403);
  let update: { startOnProxyStart: boolean; revision: string } | undefined;
  if (ctx.req.method === "POST") {
    let body: unknown;
    try { body = await readManagementJsonBody(ctx.req); }
    catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid_json" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse({ error: "invalid_request" }, 400);
    const value = body as Record<string, unknown>;
    if (Object.keys(value).some(key => !["startOnProxyStart", "revision", "confirmed"].includes(key)) || value.confirmed !== true
      || typeof value.startOnProxyStart !== "boolean" || typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision)) return jsonResponse({ error: "invalid_request" }, 400);
    update = { startOnProxyStart: value.startOnProxyStart, revision: value.revision };
  }
  const service = ctx.deps.desktopStartupSettings ?? (await import("../../codex/desktop-compatibility/startup-settings")).createDesktopStartupSettings({ liveConfig: ctx.config });
  try { return jsonResponse({ ok: true, settings: update ? service.set(update.startOnProxyStart, update.revision) : service.status() }); }
  catch (error) {
    const code = error instanceof Error ? error.message.replace(/^desktop_compatibility_settings_/, "") : "operation_unconfirmed";
    return jsonResponse({ ok: false, error: ["unavailable", "invalid", "changed", "invalid_request"].includes(code) ? `settings_${code}` : "settings_operation_unconfirmed" }, 409);
  }
}
