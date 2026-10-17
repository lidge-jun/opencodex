import type { ManagementContext } from "./context";
import { jsonResponse } from "../auth-cors";
import { saveConfigPreservingClaudeCode } from "../../config/live-reconcile";
import { commitProviderPatch } from "./provider-patch-transaction";

/** Local management auth controls intent; this route cannot install or elevate the helper. */
export async function handleChatgptNetworkRoutes(ctx: ManagementContext): Promise<Response | null> {
  let action: "status" | "enable" | "disable" | "recover";
  if (ctx.url.pathname === "/api/chatgpt-network/status" && ctx.req.method === "GET") {
    action = "status";
  } else if (ctx.url.pathname === "/api/chatgpt-network/enable" && ctx.req.method === "POST") {
    action = "enable";
  } else if (ctx.url.pathname === "/api/chatgpt-network/disable" && ctx.req.method === "POST") {
    action = "disable";
  } else if (ctx.url.pathname === "/api/chatgpt-network/recover" && ctx.req.method === "POST") {
    action = "recover";
  } else return null;
  if (!ctx.trustedLoopbackIngress || (ctx.principal !== "gui-session" && ctx.principal !== "admin-token")) {
    return jsonResponse({ ok: false, error: "Local management authority is required." }, 403);
  }
  if ((ctx.deps.platform ?? process.platform) !== "darwin" || ctx.config.runtimeRole === "client") {
    return jsonResponse({ ok: false, error: "Cloud network requires a local macOS server runtime." }, 409);
  }
  const lifecycle = ctx.deps.linkListener?.()?.cloudNetwork?.();
  if (!lifecycle) return jsonResponse({ ok: false, error: "Cloud network lifecycle is unavailable in this runtime." }, 503);
  if (action === "status") return jsonResponse({ ok: true, network: lifecycle.status() });
  const persist = () => commitProviderPatch(ctx.config, () => {
    ctx.config.chatgptDesktop = { ...ctx.config.chatgptDesktop, cloudNetwork: action === "enable" };
  }, ctx.deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode);
  try {
    const network = action === "recover" ? await lifecycle.recover(persist)
      : await lifecycle.configure(action === "enable", persist);
    const ok = network.state !== "unavailable";
    return jsonResponse({ ok, network, ...(!ok ? { error: "Cloud network is configured but unavailable.", reason: network.reason } : {}) }, ok ? 200 : 409);
  } catch {
    return jsonResponse({ ok: false, error: "Cloud network update or recovery failed; inspect status before retrying.", network: lifecycle.status() }, 409);
  }
}
