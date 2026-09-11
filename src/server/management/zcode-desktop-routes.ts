import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { connectDesktop, desktopStatus, desktopFolders, DesktopSetupError, disconnectDesktop } from "../../adapters/zcode/desktop";
import { createZcodeAdapter } from "../../adapters/zcode/adapter";
import { createTranslatorBudget } from "../../lib/translator-budget";
import { invalidateCodexModelsCache } from "../../codex/catalog";
import { clearGatherRoutedModelsInflight } from "../../codex/catalog/provider-fetch";
import { readBoundedJsonRequestBody } from "../request-decompress";

const services = { connectDesktop, desktopStatus, disconnectDesktop };
let testing = false;
export async function handleZcodeDesktopRoutes(ctx: ManagementContext, deps = services): Promise<Response | null> {
  const { req, url } = ctx;
  if (!url.pathname.startsWith("/api/zcode-desktop")) return null;
  if (url.pathname === "/api/zcode-desktop" && req.method === "GET") return jsonResponse(deps.desktopStatus());
  if (url.pathname === "/api/zcode-desktop/folders" && req.method === "GET") {
    try { return jsonResponse(desktopFolders(url.searchParams.get("path") ?? undefined)); }
    catch { return jsonResponse({ error: "workspace_invalid" }, 400); }
  }
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  // Executable/workspace selection and optional quota-spending tests require an actual GUI
  // principal, not forgeable Origin headers or a data/admin token.
  if (ctx.principal !== "gui-session") return jsonResponse({ error: "dashboard_required" }, 403);
  try {
    const raw = await readBoundedJsonRequestBody(req, 12_000, undefined, { signal: AbortSignal.any([req.signal, AbortSignal.timeout(5_000)]) });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return jsonResponse({ error: "invalid_request" }, 400);
    const body = raw as Record<string, unknown>;
    if (url.pathname === "/api/zcode-desktop/connect") {
      if (body.consent !== true || typeof body.runtime !== "string" || typeof body.workspace !== "string") return jsonResponse({ error: "consent_required" }, 400);
      const status = await deps.connectDesktop(body.runtime, body.workspace);
      invalidateCodexModelsCache(); clearGatherRoutedModelsInflight();
      return jsonResponse(status);
    }
    if (url.pathname === "/api/zcode-desktop/disconnect") {
      await deps.disconnectDesktop(); invalidateCodexModelsCache(); clearGatherRoutedModelsInflight();
      return jsonResponse(deps.desktopStatus());
    }
    if (url.pathname === "/api/zcode-desktop/test") {
      if (testing) return jsonResponse({ error: "busy" }, 409);
      const status = deps.desktopStatus();
      if (body.consent !== true || !status.connected || !status.models.some(m => m.id === body.model)) return jsonResponse({ error: "invalid_request" }, 400);
      testing = true;
      const budget = createTranslatorBudget();
      const deadline = AbortSignal.timeout(60_000);
      let completed = false;
      let textSeen = false;
      try {
        await createZcodeAdapter({ adapter: "zcode", authMode: "local", baseUrl: "https://zcode.z.ai" }).runTurn!({
          modelId: String(body.model), stream: false, options: {}, context: { messages: [
            { role: "user", timestamp: Date.now(), content: "Reply with exactly ZCODE_CONNECTION_OK. Do not use any tools." },
          ] },
        }, { headers: new Headers(), abortSignal: AbortSignal.any([req.signal, deadline]), translatorBudget: budget }, event => {
          if (event.type === "text_delta" && event.phase !== "commentary" && event.text.trim()) textSeen = true;
          if (event.type === "done") completed = true;
        });
        return jsonResponse({ ok: completed && textSeen, ...(!completed || !textSeen ? { error: "inference_failed" } : {}) });
      } finally { budget.dispose(); testing = false; }
    }
    return jsonResponse({ error: "not_found" }, 404);
  } catch (e) {
    return jsonResponse({ error: e instanceof DesktopSetupError ? e.code : "runtime_failed" }, 400);
  }
}
