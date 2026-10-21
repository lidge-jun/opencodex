import type { Server } from "bun";
import { loadConfig } from "../config";
import { browserSecurityHeaders, requestPolicyView } from "../server/auth-cors";
import { serveGuiFile, serveSessionBootstrap } from "../server/gui-static";
import {
  initializeManagementAuthState,
  issueGuiSession,
  managementPrincipal,
  requireManagementAuth,
  type ManagementAuthState,
} from "../server/management-auth";
import { resolveInboundBodyLimitBytes } from "../server/request-decompress";
import type { OcxClientConnectionConfig, OcxConfig } from "../types";
import { disconnectClient, syncConnectedClient } from "./connect";
import { isLinkConnection, readClientConnectionState } from "./state";
import { handleMachineApi, type HubReachability, type MachineApiDeps } from "./machine-api";
import { MACHINE_GUI_ORIGIN_HEADER, requireMachineAuth } from "./machine-auth";
import { HUB_RELAY_REQUEST_BODY_MAX_BYTES, relayHubManagementRequest } from "./hub-relay";
import { createLinkKeySource, handleLinkIngress, type LinkIngress, type LinkKeySourceDeps } from "./link-ingress";
import type { LinkTunnelGate } from "./link-relay";
import { readClientLinkState, type ClientLinkState } from "./link-state";
import { projectClientLinkChild, type ClientLinkSidecarRead } from "./link-status";
import type { ClientLinkSupervisorStatus } from "./link-tunnel";
import { packageVersion } from "../lib/package-version";
import { createLocalAttestationProof, LOCAL_ATTESTATION_CHALLENGE_HEADER, LOCAL_ATTESTATION_PROOF_HEADER } from "../lib/local-management-attestation";
import {
  CLIENT_RESTART_BUDGET_MS,
  parseExpectedSystemRestartPid,
  RESTART_SUPERVISED_ERROR,
  SYSTEM_RESTART_CAPABILITY_HEADER,
  SYSTEM_RESTART_CAPABILITY_VERSION,
  SYSTEM_RESTART_EXPECTED_PID_HEADER,
  SYSTEM_RESTART_METHOD,
  SYSTEM_RESTART_NONCE_HEADER,
  SYSTEM_RESTART_PATH,
  verifySystemRestartCapability,
} from "../lib/system-restart-contract";
import { linkRouteAllowed } from "../link/routes";
import { linkHomeName, linkHomePhrase } from "./link-home";
import { relayLinkManagementRead } from "./link-management-relay";
import type { ClientRestartAdmission } from "./runtime-restart";

const VERSION = packageVersion("0.0.0");
const GUI_SPA_PATHS = new Set([
  "/dashboard", "/startup", "/providers", "/models", "/subagents",
  "/logs", "/usage", "/storage", "/codex-set", "/integrations",
]);
/** The standalone listener's idle limit: long generations and held turns are never cut. */
const LINK_LISTENER_IDLE_TIMEOUT_SECONDS = 255;

export interface MachineListenerDeps {
  state?: OcxClientConnectionConfig;
  managementAuthState?: ManagementAuthState;
  fetchImpl?: typeof fetch;
  machineApi?: Partial<MachineApiDeps>;
  /** Link mode: the client tunnel supervisor state for `GET /api/link/status`. */
  linkStatus?: () => ClientLinkSupervisorStatus;
  /** Link mode: the sidecar read for `GET /api/link/status`. */
  readSidecar?: () => ClientLinkState | null;
  /** Link mode: how the link key is read; the listener reads it once and caches it. */
  linkKey?: LinkKeySourceDeps;
  /** Link mode: a key source the runtime already holds (shared with the tunnel supervisor). */
  linkKeySource?: () => string | null;
  /** Link mode: the tunnel supervisor; relayed requests wait on it while it reconnects. */
  linkTunnel?: LinkTunnelGate;
  /** Link mode: relay seams (deadline clock and byte cap). */
  linkRelay?: LinkIngress["relay"];
  /**
   * The bound restart (OCX-6). With it, `/healthz` proves this process's identity to a challenge,
   * advertises `restartCapability` and `startedAt`, and `POST /api/system/restart` accepts a
   * capability signed with `attestationSecret` for this pid and port, and nothing else.
   */
  restart?: {
    attestationSecret: string;
    /** ISO start time of this runtime's process. */
    startedAt: string;
    request: () => Promise<ClientRestartAdmission>;
  };
  serve?: (options: Parameters<typeof Bun.serve>[0]) => Server<unknown>;
}

function json404(req: Request): Response {
  const url = new URL(req.url);
  return Response.json({ error: "not_found", method: req.method, path: url.pathname }, { status: 404 });
}

function machinePolicyConfig(config: OcxConfig): OcxConfig {
  return { ...config, hostname: "127.0.0.1" };
}

export function machineRouteAllowed(url: URL, req: Request, relayEnabled: boolean, linkMode = false): boolean {
  if (req.headers.get("upgrade")) return false;
  if (linkMode && linkRouteAllowed(url, req)) return true;
  const path = url.pathname;
  if (req.method === "GET" && (path === "/healthz" || path === "/readyz" || path === "/" || path === "/opencodex-session")) return true;
  // The bound restart. Only a capability signed for this exact process admits it (see the handler).
  if (req.method === SYSTEM_RESTART_METHOD && path === SYSTEM_RESTART_PATH) return true;
  if ((req.method === "GET" || req.method === "HEAD") && (path === "/api/machine/status" || path === "/api/machine/clients" || path === "/api/machine/shim")) return true;
  // The one link route a connected Child serves: its own read-only link status.
  if (linkMode && (req.method === "GET" || req.method === "HEAD") && path === "/api/link/status") return true;
  if (req.method === "POST" && (path === "/api/machine/sync" || path === "/api/machine/shim" || path === "/api/machine/disconnect")) return true;
  if (relayEnabled && path.startsWith("/api/machine/hub-relay/")) return true;
  // Known machine endpoints are admitted for every method so an unsupported
  // method reaches the authenticated method restriction (403) instead of a
  // bare 404 that hides the endpoint entirely.
  if (path === "/api/machine/status" || path === "/api/machine/clients" || path === "/api/machine/shim"
    || path === "/api/machine/sync" || path === "/api/machine/disconnect") return true;
  if (req.method !== "GET" || path.startsWith("/api/") || path.startsWith("/v1/")) return false;
  return GUI_SPA_PATHS.has(path)
    || path.startsWith("/integrations/")
    || /\.(?:css|gif|ico|jpe?g|js|json|map|png|svg|webp|woff2?)$/i.test(path);
}

function readSidecarSafely(read: () => ClientLinkState | null): ClientLinkSidecarRead {
  try { return read(); } catch { return "invalid"; }
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
  const linkMode = isLinkConnection(connection);
  if (linkMode && !connection.link) throw new Error("link machine listener requires link transport metadata");
  const managementAuth = deps.managementAuthState ?? initializeManagementAuthState(config);
  let hubReachability: HubReachability = "unknown";
  const readSidecar = deps.readSidecar ?? (() => readClientLinkState());
  const sidecarOrNull = () => { const read = readSidecarSafely(readSidecar); return read === "invalid" ? null : read; };
  const machineApiDeps: MachineApiDeps = {
    sync: deps.machineApi?.sync ?? syncConnectedClient,
    disconnect: deps.machineApi?.disconnect ?? disconnectClient,
    scheduleStandaloneRecycle: deps.machineApi?.scheduleStandaloneRecycle ?? (() => {}),
    hubReachability: deps.machineApi?.hubReachability ?? (() => hubReachability),
    setHubReachability: deps.machineApi?.setHubReachability ?? (value => { hubReachability = value; }),
    ...(linkMode ? { linkHomeName: () => linkHomeName(connection, sidecarOrNull) } : {}),
  };
  // A link Child relays its dashboard's management reads to the Home over the link (#6957);
  // a hub client relays over its management transport when that is `relay`.
  const relayEnabled = linkMode || connection.managementTransport === "relay";
  // Link mode only. Everything is resolved once here, so a relayed request reads no file and
  // builds no policy: the key is cached, the loopback policy is fixed at bind like the listener.
  const inboundBodyLimit = resolveInboundBodyLimitBytes(config.maxInboundBodyBytes);
  const linkIngress: LinkIngress | null = linkMode
    ? {
      tunnelPort: connection.link!.tunnelPort,
      linkId: connection.link!.linkId,
      apiKeyId: connection.apiKeyId,
      policy: requestPolicyView(config, "127.0.0.1"),
      linkKey: deps.linkKeySource ?? createLinkKeySource(connection.tokenFingerprint, deps.linkKey),
      relay: { fetchImpl: deps.fetchImpl, bodyLimitBytes: inboundBodyLimit, tunnel: deps.linkTunnel, ...deps.linkRelay },
    }
    : null;
  return (deps.serve ?? (options => Bun.serve(options)))({
    port: port ?? config.port ?? 10100,
    hostname: "127.0.0.1",
    // A hub client relays only bounded management calls. A link Child carries the Codex data
    // plane, so it admits what a standalone listener admits and keeps its idle limit.
    maxRequestBodySize: linkMode ? inboundBodyLimit : HUB_RELAY_REQUEST_BODY_MAX_BYTES,
    ...(linkMode ? { idleTimeout: LINK_LISTENER_IDLE_TIMEOUT_SECONDS } : {}),
    async fetch(req: Request, server: Server<unknown>) {
      const url = new URL(req.url);
      if (linkIngress) {
        const handled = handleLinkIngress(req, url, linkIngress, server);
        if (handled) return handled;
      }
      if (!machineRouteAllowed(url, req, relayEnabled, linkMode)) return json404(req);
      if (url.pathname === "/healthz" && req.method === "GET") {
        const restart = deps.restart;
        const response = Response.json({
          service: "opencodex", version: VERSION, role: "client", uptime: process.uptime(), pid: process.pid, port: server.port,
          ...(restart ? { startedAt: restart.startedAt, restartCapability: SYSTEM_RESTART_CAPABILITY_VERSION, restartBudgetMs: CLIENT_RESTART_BUDGET_MS } : {}),
        });
        const challenge = restart ? req.headers.get(LOCAL_ATTESTATION_CHALLENGE_HEADER) : null;
        const proof = challenge && server.port
          ? createLocalAttestationProof(restart!.attestationSecret, challenge, process.pid, server.port)
          : null;
        if (proof) response.headers.set(LOCAL_ATTESTATION_PROOF_HEADER, proof);
        return response;
      }
      if (url.pathname === SYSTEM_RESTART_PATH && req.method === SYSTEM_RESTART_METHOD) {
        return await handleBoundRestart(req, server, deps.restart);
      }
      if (url.pathname === "/readyz" && req.method === "GET") {
        return Response.json({ service: "opencodex", version: VERSION, role: "client", status: "ready", uptime: process.uptime(), pid: process.pid, port: server.port, protocolVersion: 1 });
      }
      if (url.pathname.startsWith("/api/machine/hub-relay/")) {
        if (!relayEnabled) return json404(req);
        const prefix = "/api/machine/hub-relay";
        if (linkIngress) {
          const suffix = `${url.pathname.slice(prefix.length)}${url.search}`;
          // The dashboard's shared plane bootstraps here. On a link Child that plane is this
          // listener, so it receives this listener's own session; no Home credential exists.
          if (suffix === "/opencodex-session") {
            if (req.method !== "GET") return json404(req);
            const session = issueGuiSession(req, config, managementAuth, { trustedTailscaleIngress: false });
            return session ? serveSessionBootstrap(session) : Response.json({ error: "session unavailable" }, { status: 503 });
          }
          const authError = requireManagementAuth(req, managementAuth, config);
          if (authError) return authError;
          if (managementPrincipal(req, managementAuth, config) !== "gui-session") {
            return Response.json({ error: "opencodex machine GUI session required" }, { status: 401 });
          }
          const response = await relayLinkManagementRead(req, suffix, linkIngress, linkHomePhrase(connection, sidecarOrNull));
          if (response.status === 401) hubReachability = "unauthorized";
          else if (response.status >= 500) hubReachability = "offline";
          else if (response.status !== 403) hubReachability = "online";
          return response;
        }
        const authError = requireMachineAuth(req, managementAuth, config);
        if (authError) return authError;
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
      if (url.pathname.startsWith("/api/machine/") || (linkMode && url.pathname === "/api/link/status")) {
        const authError = requireManagementAuth(req, managementAuth, config);
        if (authError) return authError;
        if (managementPrincipal(req, managementAuth, config) !== "gui-session") {
          return Response.json({ error: "opencodex machine GUI session required" }, { status: 401 });
        }
        // A loopback dashboard session proves possession, not user presence: any local
        // process can fetch the dashboard bootstrap and replay its token and CSRF value.
        // Keep the connected listener useful for status/diagnostics, but never let that
        // credentialless bootstrap authorize durable machine changes. Those operations
        // remain available through the explicit CLI commands.
        if (req.method !== "GET" && req.method !== "HEAD") {
          return Response.json({ error: "opencodex machine changes require the local CLI" }, { status: 403 });
        }
        if (url.pathname === "/api/link/status") {
          // A Child never joins again from here, so the dashboard reads `joinAvailable: false`.
          const status = projectClientLinkChild(readSidecarSafely(readSidecar), deps.linkStatus?.() ?? { kind: "stopped" }, Date.now());
          return Response.json({ ...status, joinAvailable: false }, { headers: { "Cache-Control": "no-store" } });
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
  } as Parameters<typeof Bun.serve>[0]);
}

/**
 * `POST /api/system/restart` on the client listener (OCX-6). The only accepted principal is the
 * process-bound restart capability `ocx restart` derives from this runtime's attestation secret:
 * no dashboard session, admin token or link key reaches it, and a browser cannot mint it.
 */
async function handleBoundRestart(
  req: Request,
  server: Server<unknown>,
  restart: MachineListenerDeps["restart"],
): Promise<Response> {
  const noStore = { "cache-control": "no-store" };
  if (!restart || !server.port) return json404(req);
  const expected = parseExpectedSystemRestartPid(req.headers.get(SYSTEM_RESTART_EXPECTED_PID_HEADER));
  if (expected.kind !== "present" || expected.pid !== process.pid) {
    return Response.json({ success: false, error: "Restart target identity changed." }, { status: 409, headers: noStore });
  }
  const authorized = verifySystemRestartCapability(
    restart.attestationSecret,
    req.headers.get(SYSTEM_RESTART_NONCE_HEADER),
    SYSTEM_RESTART_METHOD,
    SYSTEM_RESTART_PATH,
    process.pid,
    server.port,
    req.headers.get(SYSTEM_RESTART_CAPABILITY_HEADER),
  );
  if (!authorized) return Response.json({ success: false, error: "restart capability required" }, { status: 401, headers: noStore });
  const admission = await restart.request();
  if (admission.kind === "supervised") {
    return Response.json({
      success: false,
      error: { code: RESTART_SUPERVISED_ERROR, supervisor: admission.supervisor },
    }, { status: 409, headers: noStore });
  }
  return Response.json({
    success: true,
    message: admission.alreadyRestarting ? "Restart already in progress." : "Restarting the client runtime.",
    activeTurnCount: 0,
    drainTimeoutMs: CLIENT_RESTART_BUDGET_MS,
    alreadyDraining: admission.alreadyRestarting,
  }, { status: 202, headers: noStore });
}
