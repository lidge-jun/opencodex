import { readFileSync } from "node:fs";
import type { Server } from "bun";
import { loadConfig } from "../config";
import { browserSecurityHeaders } from "../server/auth-cors";
import { serveGuiFile, serveSessionBootstrap } from "../server/gui-static";
import {
  initializeManagementAuthState,
  issueGuiSession,
  managementPrincipal,
  requireManagementAuth,
  type ManagementAuthState,
} from "../server/management-auth";
import type { OcxClientConnectionConfig, OcxConfig } from "../types";
import { disconnectClient, syncConnectedClient } from "./connect";
import { readClientConnectionState } from "./state";
import { handleMachineApi, type HubReachability, type MachineApiDeps } from "./machine-api";
import { MACHINE_GUI_ORIGIN_HEADER, requireMachineAuth } from "./machine-auth";
import { relayHubManagementRequest } from "./hub-relay";

const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string; }
  catch { return "0.0.0"; }
})();
const GUI_SPA_PATHS = new Set([
  "/dashboard", "/startup", "/providers", "/models", "/subagents",
  "/logs", "/usage", "/storage", "/codex-set", "/integrations",
]);

export interface MachineListenerDeps {
  state?: OcxClientConnectionConfig;
  managementAuthState?: ManagementAuthState;
  fetchImpl?: typeof fetch;
  machineApi?: Partial<MachineApiDeps>;
}

function json404(req: Request): Response {
  const url = new URL(req.url);
  return Response.json({ error: "not_found", method: req.method, path: url.pathname }, { status: 404 });
}

function machinePolicyConfig(config: OcxConfig): OcxConfig {
  return { ...config, hostname: "127.0.0.1" };
}

export function machineRouteAllowed(url: URL, req: Request, relayEnabled: boolean): boolean {
  if (req.headers.get("upgrade")) return false;
  const path = url.pathname;
  if (req.method === "GET" && (path === "/healthz" || path === "/readyz" || path === "/" || path === "/opencodex-session")) return true;
  if (req.method === "GET" && (path === "/api/machine/status" || path === "/api/machine/clients" || path === "/api/machine/shim")) return true;
  if (req.method === "POST" && (path === "/api/machine/sync" || path === "/api/machine/shim" || path === "/api/machine/disconnect")) return true;
  if (relayEnabled && path.startsWith("/api/machine/hub-relay/")) return true;
  if (req.method !== "GET" || path.startsWith("/api/") || path.startsWith("/v1/")) return false;
  return GUI_SPA_PATHS.has(path)
    || path.startsWith("/integrations/")
    || /\.(?:css|gif|ico|jpe?g|js|json|map|png|svg|webp|woff2?)$/i.test(path);
}

export function startMachineListener(
  port?: number,
  deps: MachineListenerDeps = {},
): Server<unknown> {
  const config = machinePolicyConfig(loadConfig());
  const connection = deps.state ?? (() => {
    const state = readClientConnectionState();
    if (state.kind !== "connected") throw new Error(`machine listener requires connected client state, got ${state.kind}`);
    return state.value;
  })();
  const managementAuth = deps.managementAuthState ?? initializeManagementAuthState(config);
  let hubReachability: HubReachability = "unknown";
  const machineApiDeps: MachineApiDeps = {
    sync: deps.machineApi?.sync ?? syncConnectedClient,
    disconnect: deps.machineApi?.disconnect ?? disconnectClient,
    scheduleStandaloneRecycle: deps.machineApi?.scheduleStandaloneRecycle ?? (() => {
      void import("./runtime").then(module => module.scheduleStandaloneRecycle());
    }),
    hubReachability: deps.machineApi?.hubReachability ?? (() => hubReachability),
    setHubReachability: deps.machineApi?.setHubReachability ?? (value => { hubReachability = value; }),
  };
  const relayEnabled = connection.managementTransport === "relay";

  return Bun.serve({
    port: port ?? config.port ?? 10100,
    hostname: "127.0.0.1",
    async fetch(req, server) {
      const url = new URL(req.url);
      if (!machineRouteAllowed(url, req, relayEnabled)) return json404(req);
      if (url.pathname === "/healthz" && req.method === "GET") {
        return Response.json({ service: "opencodex", version: VERSION, role: "client", uptime: process.uptime(), pid: process.pid, port: server.port });
      }
      if (url.pathname === "/readyz" && req.method === "GET") {
        return Response.json({ service: "opencodex", version: VERSION, role: "client", status: "ready", uptime: process.uptime(), pid: process.pid, port: server.port, protocolVersion: 1 });
      }
      if (url.pathname.startsWith("/api/machine/hub-relay/")) {
        if (!relayEnabled) return json404(req);
        const authError = requireMachineAuth(req, managementAuth, config);
        if (authError) return authError;
        const prefix = "/api/machine/hub-relay";
        const suffix = `${url.pathname.slice(prefix.length)}${url.search}`;
        const response = await relayHubManagementRequest(req, suffix, {
          managementUrl: connection.managementUrl,
          browserOrigin: req.headers.get(MACHINE_GUI_ORIGIN_HEADER) ?? req.headers.get("Origin") ?? "",
        }, { fetchImpl: deps.fetchImpl });
        if (response.status === 401) hubReachability = "unauthorized";
        else if (response.status >= 500) hubReachability = "offline";
        else hubReachability = "online";
        return response;
      }
      if (url.pathname.startsWith("/api/machine/")) {
        const authError = requireManagementAuth(req, managementAuth, config);
        if (authError) return authError;
        if (managementPrincipal(req, managementAuth, config) !== "gui-session") {
          return Response.json({ error: "opencodex machine GUI session required" }, { status: 401 });
        }
        return await handleMachineApi(req, url, connection, machineApiDeps) ?? json404(req);
      }

      const session = (url.pathname === "/" || url.pathname === "/opencodex-session")
        ? issueGuiSession(req, config, managementAuth, { trustedTailscaleIngress: false })
        : null;
      if (url.pathname === "/opencodex-session" && session) return serveSessionBootstrap(session);
      // State the role, exactly as the standalone/hub server does (src/server/index.ts).
      // The GUI decides whether a machine plane exists from this tag alone
      // (gui/src/api-targets.ts `isConnectedRuntime`): without it `discoverApiTargets`
      // returns standalone targets and never queries /api/machine/status, so a connected
      // client renders as a plain install — no hub usage scope, no "this machine" panel,
      // no connected-client list. This listener only ever serves a connected client, so
      // the role is a constant here rather than a config read.
      const gui = serveGuiFile(url.pathname, undefined, session ?? undefined, "client");
      if (gui) return gui;
      if (url.pathname === "/") {
        return Response.json({
          status: "ok",
          service: "opencodex",
          version: VERSION,
          role: "client",
          dashboard: { available: false, reason: "GUI build not found" },
          endpoints: { health: "/healthz", ready: "/readyz", machine: "/api/machine/*" },
        }, { headers: browserSecurityHeaders() });
      }
      return json404(req);
    },
  });
}
