import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { connectDesktop, desktopStatus, desktopFolders, DesktopSetupError, disconnectDesktop, verifyDesktopProtocol } from "../../adapters/zcode/desktop";
import { invalidateCodexModelsCache } from "../../codex/catalog";
import { clearGatherRoutedModelsInflight } from "../../codex/catalog/provider-fetch";
import { readBoundedJsonRequestBody } from "../request-decompress";
import { activateDesktopProvider, deactivateDesktopProvider, desktopActivation, readDesktopCatalogSlugs } from "./zcode-desktop-activation";

const services = { connectDesktop, desktopStatus, disconnectDesktop, verifyDesktopProtocol, readDesktopCatalogSlugs };
let activating = false;
let testing = false;
export async function handleZcodeDesktopRoutes(ctx: ManagementContext, deps = services): Promise<Response | null> {
  const { req, url } = ctx;
  if (!url.pathname.startsWith("/api/zcode-desktop")) return null;
  // Runtime/workspace paths are local-machine metadata. Every Desktop endpoint requires an
  // actual GUI session; an admin token may manage providers but must not inspect host paths.
  if (ctx.principal !== "gui-session") return jsonResponse({ error: "dashboard_required" }, 403);
  if (url.pathname === "/api/zcode-desktop" && req.method === "GET") return jsonResponse(desktopActivation(ctx, deps.desktopStatus(), deps.readDesktopCatalogSlugs));
  if (url.pathname === "/api/zcode-desktop/folders" && req.method === "GET") {
    try { return jsonResponse(desktopFolders(url.searchParams.get("path") ?? undefined)); }
    catch { return jsonResponse({ error: "workspace_invalid" }, 400); }
  }
  if (req.method !== "POST") return null;
  try {
    const raw = await readBoundedJsonRequestBody(req, 12_000, undefined, { signal: AbortSignal.any([req.signal, AbortSignal.timeout(5_000)]) });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return jsonResponse({ error: "invalid_request" }, 400);
    const body = raw as Record<string, unknown>;
    if (url.pathname === "/api/zcode-desktop/connect" && req.method === "POST"
      || url.pathname === "/api/zcode-desktop/activate" && req.method === "POST") {
      if (body.consent !== true || typeof body.runtime !== "string" || typeof body.workspace !== "string") return jsonResponse({ error: "consent_required" }, 400);
      if (activating) return jsonResponse({ error: "busy" }, 409);
      activating = true;
      try {
        const status = url.pathname.endsWith("/activate") ? deps.desktopStatus() : await deps.connectDesktop(body.runtime, body.workspace);
        if (url.pathname.endsWith("/activate") && (status.runtime !== body.runtime || status.workspace !== body.workspace)) return jsonResponse({ error: "invalid_request" }, 409);
        clearGatherRoutedModelsInflight();
        return jsonResponse(await activateDesktopProvider(ctx, status, deps.readDesktopCatalogSlugs));
      } finally { activating = false; }
    }
    if (url.pathname === "/api/zcode-desktop/disconnect" && req.method === "POST") {
      if (activating) return jsonResponse({ error: "busy" }, 409);
      activating = true;
      try {
        await deps.disconnectDesktop(); invalidateCodexModelsCache(); clearGatherRoutedModelsInflight();
        return jsonResponse(await deactivateDesktopProvider(ctx, deps.desktopStatus(), deps.readDesktopCatalogSlugs));
      } finally { activating = false; }
    }
    if (url.pathname === "/api/zcode-desktop/test" && req.method === "POST") {
      if (testing) return jsonResponse({ error: "busy" }, 409);
      const status = deps.desktopStatus();
      if (body.consent !== true || !status.connected || !status.models.some(m => m.id === body.model)) return jsonResponse({ error: "invalid_request" }, 400);
      testing = true;
      try {
        await deps.verifyDesktopProtocol(String(body.model), AbortSignal.any([req.signal, AbortSignal.timeout(35_000)]));
        return jsonResponse({ ok: true });
      } finally { testing = false; }
    }
    return jsonResponse({ error: "not_found" }, 404);
  } catch (e) {
    return jsonResponse({ error: e instanceof DesktopSetupError ? e.code
      : url.pathname === "/api/zcode-desktop/test" ? "protocol_failed" : "runtime_failed" }, 400);
  }
}
