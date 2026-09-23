import { journalOwner } from "../codex/journal";
import { diagnoseCodexShim, installCodexShim, uninstallCodexShim } from "../codex/shim";
import { readManagementJsonBody } from "../server/management/body";
import type { OcxClientConnectionConfig } from "../types";
import { disconnectClient, syncConnectedClient } from "./connect";

export type HubReachability = "unknown" | "online" | "offline" | "unauthorized";

export interface MachineStatusV1 {
  mode: "client";
  connected: true;
  machineBase: string;
  sharedBase: string;
  sharedServerOrigin: string;
  managementTransport: "direct" | "relay";
  apiKeyId: string;
  protocolVersion: 1;
  connectedAt: string;
  catalogSyncedAt?: string;
  hubReachability: HubReachability;
}

export interface MachineApiDeps {
  sync: typeof syncConnectedClient;
  disconnect: typeof disconnectClient;
  scheduleStandaloneRecycle: (disconnectedTokenFingerprint: string) => void;
  hubReachability?: () => HubReachability;
  setHubReachability?: (value: HubReachability) => void;
}

const defaultDeps: MachineApiDeps = {
  sync: syncConnectedClient,
  disconnect: disconnectClient,
  scheduleStandaloneRecycle: () => {},
};

function strictObject(value: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every(key => allowed.includes(key)) ? record : null;
}

async function jsonBody(req: Request): Promise<unknown | Response> {
  try {
    return await readManagementJsonBody(req);
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
}

function statusPayload(req: Request, state: OcxClientConnectionConfig, deps: MachineApiDeps): MachineStatusV1 {
  const machineBase = new URL(req.url).origin;
  return {
    mode: "client",
    connected: true,
    machineBase,
    sharedBase: state.managementTransport === "relay"
      ? `${machineBase}/api/machine/hub-relay`
      : state.managementUrl,
    sharedServerOrigin: state.managementUrl,
    managementTransport: state.managementTransport,
    apiKeyId: state.apiKeyId,
    protocolVersion: state.protocolVersion,
    connectedAt: state.connectedAt,
    ...(state.catalogSyncedAt ? { catalogSyncedAt: state.catalogSyncedAt } : {}),
    hubReachability: deps.hubReachability?.() ?? "unknown",
  };
}

export async function handleMachineApi(
  req: Request,
  url: URL,
  state: OcxClientConnectionConfig,
  injected: MachineApiDeps = defaultDeps,
): Promise<Response | null> {
  const deps = { ...defaultDeps, ...injected };
  const readMethod = req.method === "GET" || req.method === "HEAD";
  if (url.pathname === "/api/machine/status" && readMethod) {
    return Response.json(statusPayload(req, state, deps), { headers: { "Cache-Control": "no-store" } });
  }
  if (url.pathname === "/api/machine/clients" && readMethod) {
    return Response.json({
      selectedClients: [...state.selectedClients],
      journalOwner: journalOwner(),
      shim: diagnoseCodexShim(),
    }, { headers: { "Cache-Control": "no-store" } });
  }
  if (url.pathname === "/api/machine/sync" && req.method === "POST") {
    const body = await jsonBody(req);
    if (body instanceof Response) return body;
    const input = strictObject(body, ["restartCodex"]);
    if (!input || (input.restartCodex !== undefined && typeof input.restartCodex !== "boolean")) {
      return Response.json({ error: "invalid sync request" }, { status: 400 });
    }
    try {
      const result = await deps.sync(
        input.restartCodex === undefined ? {} : { restartCodex: input.restartCodex },
      );
      deps.setHubReachability?.("online");
      return Response.json({ success: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "client sync failed";
      deps.setHubReachability?.(/unauthor/i.test(message) ? "unauthorized" : "offline");
      return Response.json({ success: false, error: message }, { status: 502 });
    }
  }
  if (url.pathname === "/api/machine/shim" && readMethod) {
    return Response.json(diagnoseCodexShim(), { headers: { "Cache-Control": "no-store" } });
  }
  if (url.pathname === "/api/machine/shim" && req.method === "POST") {
    const body = await jsonBody(req);
    if (body instanceof Response) return body;
    const input = strictObject(body, ["action"]);
    if (!input || (input.action !== "install" && input.action !== "repair" && input.action !== "uninstall")) {
      return Response.json({ error: "action must be install, repair, or uninstall" }, { status: 400 });
    }
    try {
      const result = input.action === "uninstall" ? uninstallCodexShim() : installCodexShim();
      return Response.json({ success: true, action: input.action, result, shim: diagnoseCodexShim() });
    } catch (error) {
      return Response.json({ success: false, error: error instanceof Error ? error.message : "shim action failed" }, { status: 409 });
    }
  }
  if (url.pathname === "/api/machine/disconnect" && req.method === "POST") {
    const body = await jsonBody(req);
    if (body instanceof Response) return body;
    const input = strictObject(body, ["keepCatalog"]);
    if (!input || (input.keepCatalog !== undefined && typeof input.keepCatalog !== "boolean")) {
      return Response.json({ error: "invalid disconnect request" }, { status: 400 });
    }
    try {
      const result = await deps.disconnect(input.keepCatalog === undefined ? {} : { keepCatalog: input.keepCatalog });
      deps.scheduleStandaloneRecycle(state.tokenFingerprint);
      return Response.json({ success: true, ...result }, { status: 202 });
    } catch (error) {
      return Response.json({ success: false, error: error instanceof Error ? error.message : "disconnect failed" }, { status: 409 });
    }
  }
  return null;
}
