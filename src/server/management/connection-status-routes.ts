/**
 * `GET /api/connections` — the read-only Connections view (catch-up 010, G-001).
 *
 * Lazy-loaded by namespace from management-api.ts, like the other optional surfaces, so the
 * projections' imports stay off every other dashboard request. Nothing here writes: every
 * projection is a read of the files the switches act on.
 */
import { readConfigDiagnostics } from "../../config/diagnostics";
import type { OcxConfig } from "../../types";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

/** The persisted config a switch would transition; the live snapshot when there is no readable file. */
export function persistedConfigOr(live: OcxConfig): OcxConfig {
  try {
    const latest = readConfigDiagnostics({ passive: true });
    return latest.source === "file" && !latest.error ? latest.config : live;
  } catch {
    return live;
  }
}

export async function handleConnectionStatusRoutes(ctx: ManagementContext): Promise<Response | null> {
  if (ctx.url.pathname === "/api/connections" && ctx.req.method === "GET") return connectionsResponse(ctx);
  return null;
}

async function connectionsResponse(ctx: ManagementContext): Promise<Response> {
  const { req, config, deps } = ctx;
  try {
    const [{ projectCodexConnection }, { projectClaudeConnections }, { getClaudeInterceptState }] = await Promise.all([
      import("../../codex/connection-projection"),
      import("../../claude/connection-projection"),
      import("../../claude/intercept/runtime"),
    ]);
    const bound = (deps.getClaudeInterceptState ?? getClaudeInterceptState)();
    const connections = [
      projectCodexConnection(persistedConfigOr(config)),
      ...projectClaudeConnections({ live: config, persisted: persistedConfigOr(config), boundProxyPort: bound?.proxyPort ?? null }),
    ];
    return jsonResponse({ connections }, 200, req, config);
  } catch {
    // A fixed body: an error message can carry a path or a settings value.
    return jsonResponse({ error: "connection status could not be read", code: "connections_failed" }, 500, req, config);
  }
}
