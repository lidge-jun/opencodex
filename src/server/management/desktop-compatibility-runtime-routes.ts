import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";
import type { DesktopCompatibilityRuntime } from "../../codex/desktop-compatibility/runtime";

const PATH = "/api/codex/desktop-compatibility/runtime";
const ERROR_CODES = new Set(["busy", "unsupported", "test_environment", "stopping", "build_unverified", "egress_proxy_invalid",
  "trust_required", "certificate_expiring", "certificate_not_prepared", "certificate_invalid", "certificate_expired",
  "native_identity_unverified", "native_routing_unverified", "cleanup_incomplete", "not_running", "connection_invalid", "connection_changed", "connection_cleanup_required", "connection_unavailable"]);

export async function handleDesktopCompatibilityRuntimeRoutes(ctx: ManagementContext): Promise<Response | null> {
  if (ctx.url.pathname !== PATH) return null;
  if (ctx.req.method !== "GET" && ctx.req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  if (ctx.req.method === "POST" && (ctx.principal !== "gui-session" || !ctx.trustedLoopbackIngress)) return jsonResponse({ error: "local_dashboard_confirmation_required" }, 403);
  let action: "start" | "stop" | "observe" | "apply" | "launch" | undefined;
  if (ctx.req.method === "POST") {
    let body: unknown;
    try { body = await readManagementJsonBody(ctx.req); }
    catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid_json" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse({ error: "invalid_request" }, 400);
    const value = body as Record<string, unknown>;
    if (Object.keys(value).some(key => !["action", "confirmed", "accountWideConsent"].includes(key)) || value.confirmed !== true
      || typeof value.action !== "string" || !["start", "stop", "observe", "apply", "launch"].includes(value.action)) return jsonResponse({ error: "invalid_request" }, 400);
    if (value.action === "apply" ? value.accountWideConsent !== true : value.accountWideConsent !== undefined) return jsonResponse({ error: "invalid_consent_scope" }, 400);
    action = value.action as typeof action;
  }
  const module = ctx.deps.desktopCompatibilityRuntime ? null : await import("../../codex/desktop-compatibility/service");
  const service: DesktopCompatibilityRuntime = ctx.deps.desktopCompatibilityRuntime ?? module!.getDesktopCompatibilityRuntime();
  if (module) ctx.deps.onDesktopCompatibilityShutdown?.(module.shutdownDesktopCompatibility);
  try {
    if (action === "apply") {
      const result = await service.apply(true);
      return jsonResponse({ ok: result.accepted, activation: result, runtime: service.status() }, result.accepted ? 202 : 409);
    }
    if (action === "launch") {
      const result = await service.launch();
      return jsonResponse({ ok: result.status === "started", launch: result, runtime: service.status() }, result.status === "started" ? 200 : 409);
    }
    const result = action === "start" ? await service.start() : action === "stop" ? await service.stop()
      : action === "observe" ? await service.observe() : service.status();
    return jsonResponse({ ok: true, runtime: result });
  } catch (error) {
    const code = error instanceof Error ? error.message.replace(/^desktop_compatibility_/, "") : "operation_failed";
    return jsonResponse({ ok: false, error: ERROR_CODES.has(code) ? code : "operation_failed", runtime: service.status() }, 409);
  }
}
