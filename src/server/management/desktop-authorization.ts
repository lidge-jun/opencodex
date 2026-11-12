import { desktopGuiOrigin, hasDesktopForwardingHeaders } from "../../lib/desktop-gui-origin";
import { DESKTOP_AUTHORIZATION_PATH } from "../gui-desktop-authorization";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";

function localDesktopBrowser(ctx: ManagementContext): boolean {
  return ctx.principal === "gui-session" && ctx.trustedLoopbackIngress
    && (ctx.deps.liveListenPort?.() ?? ctx.config.port) === ctx.config.port
    && !hasDesktopForwardingHeaders(ctx.req)
    && desktopGuiOrigin(ctx.config, ctx.url.origin) === ctx.url.origin;
}

export function requireDesktopAuthorization(ctx: ManagementContext): Response | null {
  const livePort = ctx.deps.liveListenPort?.() ?? ctx.config.port;
  const authorized = ctx.sessionControl?.canMutateLocalDesktop?.(ctx.req,
    livePort === ctx.config.port ? ctx.config : { ...ctx.config, port: livePort });
  return localDesktopBrowser(ctx) && authorized
    ? null : jsonResponse({ error: "desktop_authorization_required" }, 403);
}

export async function handleDesktopAuthorization(ctx: ManagementContext): Promise<Response | null> {
  if (ctx.url.pathname !== DESKTOP_AUTHORIZATION_PATH) return null;
  if (ctx.req.method === "GET") return jsonResponse({ ok: true,
    supported: localDesktopBrowser(ctx), authorized: requireDesktopAuthorization(ctx) === null });
  if (ctx.req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  if (!localDesktopBrowser(ctx) || !ctx.sessionControl?.isCurrent(ctx.req, ctx.config)) return jsonResponse({ error: "desktop_authorization_required" }, 403);
  let body: unknown;
  try { body = await readManagementJsonBody(ctx.req); }
  catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid_json" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1
    || !("grant" in body) || typeof body.grant !== "string") return jsonResponse({ error: "invalid_request" }, 400);
  return localDesktopBrowser(ctx) && ctx.sessionControl?.authorizeLocalDesktop?.(ctx.req, ctx.config, body.grant)
    ? jsonResponse({ ok: true, authorized: true }) : jsonResponse({ error: "desktop_authorization_required" }, 403);
}
