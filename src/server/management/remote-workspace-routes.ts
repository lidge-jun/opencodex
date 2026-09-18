import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { remoteWorkspaceEnabled } from "../../remote-control/workspace-activation";
import type { ManagementContext } from "./context";
import { isRemoteWorkspaceAgentProfile } from "../../remote-control/workspace-agent-protocol";

const REMOTE_WORKSPACE_PREFIX = "/api/remote-workspace";

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function sessionOnly(ctx: ManagementContext): Response | null {
  return ctx.principal === "gui-session"
    ? null
    : response({ error: "A dashboard session is required for Remote Workspace changes." }, 403);
}

async function jsonObject(req: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); throw new Error("Remote Workspace request body must be JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Remote Workspace request body must be an object.");
  }
  return value as Record<string, unknown>;
}

function exactBodyKeys(
  body: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.hasOwn(body, key))
    || Object.keys(body).some(key => !allowed.has(key))) {
    throw new Error("Remote Workspace request body contains invalid fields.");
  }
}

export async function handleRemoteWorkspaceRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (!url.pathname.startsWith(REMOTE_WORKSPACE_PREFIX)) return null;
  if (url.pathname.length > REMOTE_WORKSPACE_PREFIX.length
    && url.pathname[REMOTE_WORKSPACE_PREFIX.length] !== "/") return null;
  if (!remoteWorkspaceEnabled(config)) {
    return response({ available: false, reason: "Remote Workspace requires this OpenCodex instance to run as a hub." }, 409);
  }
  if (req.method !== "GET") {
    const denied = sessionOnly(ctx);
    if (denied) return denied;
  }
  if (ctx.deps.remoteWorkspaceStopping?.()) return response({ error: "Remote Workspace is stopping." }, 503);
  const runtime = await import("../../remote-control/workspace-runtime");
  if (ctx.deps.remoteWorkspaceStopping?.()) return response({ error: "Remote Workspace is stopping." }, 503);
  const hub = ctx.deps.remoteWorkspaceHub ?? runtime.remoteWorkspaceHubForConfig(config);
  const sessions = ctx.deps.remoteWorkspaceSessions ?? runtime.remoteWorkspaceSessionsForConfig(config);
  ctx.deps.onRemoteWorkspaceShutdown?.(async () => {
    const sessions = ctx.deps.remoteWorkspaceSessions ?? runtime.initializedRemoteWorkspaceSessionsForConfig(config);
    const hub = ctx.deps.remoteWorkspaceHub ?? runtime.initializedRemoteWorkspaceHubForConfig(config);
    try { await sessions?.shutdown(); } finally { hub?.closeAllConnections(); }
  });
  if (url.pathname === "/api/remote-workspace" && req.method === "GET") {
    return response({
      available: true,
      devices: hub.listDevices(),
      runtimes: await sessions.availability(),
      sessions: sessions.list(),
    });
  }
  if (url.pathname === "/api/remote-workspace/pairing" && req.method === "POST") {
    const denied = sessionOnly(ctx);
    if (denied) return denied;
    try {
      return response(hub.createPairingGrant(), 201);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return response({ error: error instanceof Error ? error.message : "Remote Workspace pairing failed." }, 429);
    }
  }
  const match = /^\/api\/remote-workspace\/devices\/([0-9a-f-]+)$/i.exec(url.pathname);
  if (match && req.method === "DELETE") {
    const denied = sessionOnly(ctx);
    if (denied) return denied;
    if (!hub.revokeDevice(match[1]!)) return response({ error: "Remote Workspace device not found." }, 404);
    await Promise.all(sessions.list()
      .filter(session => session.deviceId === match[1] && session.status !== "stopped")
      .map(session => sessions.stop(session.id)));
    return response({ ok: true });
  }
  if (url.pathname === "/api/remote-workspace/sessions" && req.method === "GET") {
    return response({ sessions: sessions.list() });
  }
  if (url.pathname === "/api/remote-workspace/runtimes" && req.method === "GET") {
    return response({ runtimes: await sessions.availability() });
  }
  if (url.pathname === "/api/remote-workspace/sessions" && req.method === "POST") {
    const denied = sessionOnly(ctx);
    if (denied) return denied;
    try {
      const body = await jsonObject(req);
      exactBodyKeys(body, ["profile", "deviceId", "rootId"], ["accessMode"]);
      if (!isRemoteWorkspaceAgentProfile(body.profile)
        || typeof body.deviceId !== "string"
        || typeof body.rootId !== "string"
        || (body.accessMode !== undefined && body.accessMode !== "read-only" && body.accessMode !== "workspace")) {
        throw new Error("profile, deviceId, rootId, and a valid accessMode are required.");
      }
      return response(await sessions.create({
        profile: body.profile,
        deviceId: body.deviceId,
        rootId: body.rootId,
        accessMode: body.accessMode === "workspace" ? "workspace" : "read-only",
      }), 201);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return response({ error: error instanceof Error ? error.message : "Remote Workspace session failed." }, 409);
    }
  }
  const promptMatch = /^\/api\/remote-workspace\/sessions\/([0-9a-f-]+)\/prompt$/i.exec(url.pathname);
  if (promptMatch && req.method === "POST") {
    const denied = sessionOnly(ctx);
    if (denied) return denied;
    try {
      const body = await jsonObject(req);
      exactBodyKeys(body, ["prompt"]);
      return response(sessions.submitPrompt(promptMatch[1]!, body.prompt), 202);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return response({ error: error instanceof Error ? error.message : "Remote Workspace turn failed." }, 409);
    }
  }
  const sessionMatch = /^\/api\/remote-workspace\/sessions\/([0-9a-f-]+)$/i.exec(url.pathname);
  if (sessionMatch && req.method === "DELETE") {
    const denied = sessionOnly(ctx);
    if (denied) return denied;
    return await sessions.stop(sessionMatch[1]!)
      ? response({ ok: true })
      : response({ error: "Remote Workspace session not found." }, 404);
  }
  return response({ error: "Unknown Remote Workspace operation." }, 404);
}
