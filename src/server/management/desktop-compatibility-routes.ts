import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";
import type { DesktopCertificateService } from "../../codex/desktop-compatibility/certificate-service";

const PATH = "/api/codex/desktop-compatibility/certificate";
let service: DesktopCertificateService | undefined;

export async function handleDesktopCompatibilityRoutes(ctx: ManagementContext): Promise<Response | null> {
  if (ctx.url.pathname !== PATH) return null;
  if (ctx.req.method !== "GET" && ctx.req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  // A local dashboard confirmation precedes any persisted key or CurrentUser Root mutation.
  // This is caller provenance, not protection against an arbitrary same-user process.
  if (ctx.req.method === "POST" && (ctx.principal !== "gui-session" || !ctx.trustedLoopbackIngress)) {
    return jsonResponse({ error: "local_dashboard_confirmation_required" }, 403);
  }
  let action: "prepare" | "trust" | "remove-trust" | "renew" | undefined, fingerprint: string | undefined;
  if (ctx.req.method === "POST") {
    let body: unknown;
    try { body = await readManagementJsonBody(ctx.req); }
    catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid_json" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse({ error: "invalid_request" }, 400);
    const value = body as Record<string, unknown>;
    if (Object.keys(value).some(key => !["action", "fingerprint", "confirmed"].includes(key)) || value.confirmed !== true
      || typeof value.action !== "string" || !["prepare", "trust", "remove-trust", "renew"].includes(value.action)) return jsonResponse({ error: "invalid_request" }, 400);
    action = value.action as typeof action;
    if (action !== "prepare" && (typeof value.fingerprint !== "string" || !/^[A-F0-9]{64}$/.test(value.fingerprint))) {
      return jsonResponse({ error: "certificate_fingerprint_required" }, 400);
    }
    if (action === "prepare" && value.fingerprint !== undefined) return jsonResponse({ error: "unexpected_fingerprint" }, 400);
    fingerprint = value.fingerprint as string | undefined;
  }
  const controller = ctx.deps.desktopCertificateService ?? (service ??= (await import("../../codex/desktop-compatibility/certificate-service")).createDesktopCertificateService());
  try {
    const status = action === "prepare" ? await controller.prepare()
      : action === "trust" ? await controller.trust(fingerprint!)
      : action === "renew" ? await controller.renew(fingerprint!)
      : action === "remove-trust" ? await controller.removeTrust(fingerprint!) : await controller.status();
    return jsonResponse({ ok: true, certificate: status });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "operation_failed";
    const allowed = new Set(["unsupported", "busy", "not_prepared", "fingerprint_changed", "app_running", "runtime_running", "app_state_unknown", "trust_unknown", "trust_not_applied",
      "unsafe_path", "unreadable", "expired", "renewal_required", "protection_failed"]);
    return jsonResponse({ ok: false, error: allowed.has(code) ? code : "operation_failed" }, 409);
  }
}
