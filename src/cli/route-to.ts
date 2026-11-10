import {
  CliUsageError, RuntimeApiError, printData, rejectArgs, runCliAction, runtimeRequest, terminalSafeText,
  type RuntimeApiDeps,
} from "./runtime-api";
import { integrationFlag, integrationOption } from "./integration-input";
import { readLinkChildContext, linkChildRefusal, type LinkChildContext } from "./link-child";
import { isRouteClientId, parseRouteClientIntent } from "../link/route-intent";
import type { RouteToStatus } from "../routing/route-to-status";

export const ROUTE_TO_USAGE = `Usage:
  ocx route to status [--device <alias|id|all|this>] [--json]
  ocx route to sync [--device <alias|id|all|this>] [--overwrite-conflict] [--json]
  ocx route to <client> <on|off|inherit> [--device <alias|id|this>] [--accounts <all|none|userId,...>] [--model-names <alias|routed>] [--overwrite-conflict] [--json]
  ocx route to <client> <off|inherit> --local [--device this] [--json]`;

const loadLocal = () => import("../routing/route-to-local");
export interface RouteToDeps extends RuntimeApiDeps {
  readChildContext?: () => LinkChildContext | null;
  loadLocal?: typeof loadLocal;
}

export function routeToStatusLines(status: RouteToStatus): string[] {
  return ["DEVICE  CLIENT  INTENT  SOURCE  APPLIED  TARGET", ...status.devices.flatMap(device =>
    device.routeIntent === "unsupported" ? [`${device.alias || device.id}  route intent unsupported (${device.reason ?? "unsupported"})`]
      : device.clients.map(row => [device.alias || device.id, row.client, row.intent, row.source,
        row.applied ?? "-", row.target ?? "-"].join("  "))),
    ...(status.syncs ?? []).map(row => `sync ${row.id}: ${row.state}${row.reason ? ` (${row.reason})` : ""}`),
    ...(status.deferred ? [`Local reconciliation deferred: Home intent or the Child catalog is unavailable${status.deferred.clients.length ? ` (${status.deferred.clients.join(", ")})` : ""}.`] : [])];
}

function accountsOption(raw: string | undefined): "all" | "none" | string[] | undefined {
  if (raw === undefined || raw === "all" || raw === "none") return raw;
  const values = raw.split(",").map(value => value.trim());
  if (!parseRouteClientIntent({ enabled: true, accounts: values }, "aside")
    || values.some(value => value === "all" || value === "none")) {
    throw new CliUsageError("--accounts requires all, none, or unique Aside userIds (not u/N slots)", ROUTE_TO_USAGE);
  }
  return values;
}

/** Shared with legacy toggle aliases, inside their existing error boundary. */
export async function routeToAction(argv: string[], deps: RouteToDeps = {}): Promise<void> {
  const args = [...argv];
  const json = integrationFlag(args, "--json");
  const local = integrationFlag(args, "--local");
  const overwriteConflict = integrationFlag(args, "--overwrite-conflict");
  const device = integrationOption(args, "--device");
  const accounts = accountsOption(integrationOption(args, "--accounts"));
  const modelNames = integrationOption(args, "--model-names");
  const subject = args.shift() ?? "status";
  const read = subject === "status";
  const sync = subject === "sync";
  const client = read || sync ? undefined : subject;
  const action = client === undefined ? undefined : args.shift();
  rejectArgs(args, ROUTE_TO_USAGE);
  if (device !== undefined && (!device.trim() || /[\x00-\x20\x7f]/.test(device))) {
    throw new CliUsageError("--device requires an alias, id, all or this", ROUTE_TO_USAGE);
  }
  if (client !== undefined && !isRouteClientId(client)) {
    throw new CliUsageError("Expected a supported route-to client", ROUTE_TO_USAGE);
  }
  if (client !== undefined && !["on", "off", "inherit"].includes(action ?? "")) {
    throw new CliUsageError("Expected a supported client and on, off or inherit", ROUTE_TO_USAGE);
  }
  if (client !== undefined && device === "all") {
    throw new CliUsageError("--device all applies only to status or sync; omit --device to change the Home default", ROUTE_TO_USAGE);
  }
  if (modelNames !== undefined && (modelNames !== "alias" && modelNames !== "routed")) {
    throw new CliUsageError("--model-names must be alias or routed", ROUTE_TO_USAGE);
  }
  if (accounts !== undefined && (client !== "aside" || action !== "on")) {
    throw new CliUsageError("--accounts requires aside on", ROUTE_TO_USAGE);
  }
  if (modelNames !== undefined && (action !== "on" || (client !== "hermes" && client !== "commandcode"))) {
    throw new CliUsageError("--model-names requires hermes or commandcode on", ROUTE_TO_USAGE);
  }
  if (overwriteConflict && !sync && action !== "on") {
    throw new CliUsageError("--overwrite-conflict applies only to on or sync", ROUTE_TO_USAGE);
  }
  if (local && (client === undefined || !["off", "inherit"].includes(action ?? "") || overwriteConflict)) {
    throw new CliUsageError("--local supports only client off or inherit", ROUTE_TO_USAGE);
  }
  if (action === "inherit" && device === undefined && !local) {
    throw new CliUsageError("inherit requires --device or --local", ROUTE_TO_USAGE);
  }

  // Detect Child before runtimeRequest: these operations must never enter its Home relay.
  const child = (deps.readChildContext ?? readLinkChildContext)();
  let result: unknown;
  let requestFailure: RuntimeApiError | undefined;
  if (child) {
    if (device !== undefined && device !== "this" && device !== child.linkId) {
      throw new CliUsageError("A Child can target only --device this or its own link id", ROUTE_TO_USAGE);
    }
    if (client !== undefined && !local) {
      const command = ["ocx route to", client, action, "--device", child.linkId,
        ...(accounts === undefined ? [] : ["--accounts", Array.isArray(accounts) ? accounts.join(",") : accounts]),
        ...(modelNames === undefined ? [] : ["--model-names", modelNames]),
        ...(overwriteConflict ? ["--overwrite-conflict"] : [])].join(" ");
      throw new RuntimeApiError(`${linkChildRefusal(child)}\nRun on the Home: ${command}`, 409, null);
    }
    const api = await (deps.loadLocal ?? loadLocal)();
    result = read ? await api.readLocalRouteToStatus(child)
      : sync ? await api.syncLocalRouteTo(child, overwriteConflict)
      : await api.setLocalRouteToOff(child, client!, action === "off");
  } else {
    if (local) throw new CliUsageError("--local requires a Remote Link Child", ROUTE_TO_USAGE);
    const body = { ...(device === undefined ? {} : { device }),
      ...(overwriteConflict ? { overwriteConflict: true } : {}) };
    try {
      result = read ? await runtimeRequest(`/api/route-to${device === undefined ? "" : `?device=${encodeURIComponent(device)}`}`, { redirect: "error" }, deps)
      : await runtimeRequest(sync ? "/api/route-to/sync" : "/api/route-to", {
        method: sync ? "POST" : "PUT", redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sync ? body : { client, action, ...body,
          ...(accounts === undefined ? {} : { accounts }), ...(modelNames === undefined ? {} : { modelNames }) }),
      }, deps);
    } catch (error) {
      if (!(error instanceof RuntimeApiError) || !error.body || typeof error.body !== "object"
        || !("schema" in error.body) || error.body.schema !== "ocx.route-to/1") throw error;
      requestFailure = error;
      result = error.body;
    }
  }
  const status = result as RouteToStatus;
  if (!status || status.schema !== "ocx.route-to/1" || !Array.isArray(status.devices) || status.devices.length === 0
    || (status.deferred !== undefined && (!status.deferred || status.deferred.reason !== "intent_or_catalog_pending"
      || !Array.isArray(status.deferred.clients) || status.deferred.clients.some(client => !isRouteClientId(client))))
    || (status.syncs !== undefined && (!Array.isArray(status.syncs) || status.syncs.some(row => !row || typeof row.id !== "string"
      || !["synced", "failed", "pending", "unsupported"].includes(row.state) || (row.reason !== undefined && typeof row.reason !== "string"))))
    || (status.warnings !== undefined && (!Array.isArray(status.warnings) || status.warnings.some(row => typeof row !== "string")))
    || status.devices.some(row => !row || typeof row.id !== "string" || !Array.isArray(row.clients)
      || (row.routeIntent === undefined ? row.clients.length === 0
        : row.routeIntent !== "unsupported" || row.clients.length !== 0 || typeof row.reason !== "string")
      || (row.alias !== undefined && typeof row.alias !== "string")
      || row.clients.some(client => !client || !isRouteClientId(client.client)
        || (client.intent !== "on" && client.intent !== "off" && !(client.intent === "unresolved" && client.client === "aside"))
        || !["builtin", "default", "device", "native", "local"].includes(client.source)
        || (client.applied !== null && !["current", "stale", "not_installed", "conflict", "failed"].includes(client.applied))
        || (client.target !== undefined && typeof client.target !== "string")))) {
    throw new RuntimeApiError("Invalid route-to status response; outcome is unverified. Read status before retrying.", 502, null);
  }
  if (!read) {
    const requested = child?.linkId ?? (device === undefined || device === "this" ? "home" : device);
    const matching = status.devices.filter(row => row.id === requested || row.alias === requested);
    if ((requested !== "all" && matching.length !== 1)
      || (client !== undefined && !matching[0]?.clients.some(row => row.client === client))) {
      throw new RuntimeApiError("Invalid route-to status response; requested device/client is unverified. Read status before retrying.", 502, null);
    }
  }
  printData(status, json, routeToStatusLines(status));
  // Notices about a client the request left alone; the JSON body carries them too.
  for (const warning of status.warnings ?? []) console.error(terminalSafeText(warning));
  if (requestFailure) throw requestFailure;
  if (status.syncs?.some(row => row.state === "failed")) {
    throw new RuntimeApiError("Route sync failed for one or more devices. Read status before retrying.", 502, null);
  }
  if (sync && status.deferred) {
    throw new RuntimeApiError("Local route sync is deferred; not all client configurations were reconciled. Retry when the Home and Child catalog are available.", 503, null);
  }
  const failedClients = status.devices.flatMap(row => row.clients.filter(entry => entry.applied === "failed" || entry.applied === "conflict"));
  if (!read && failedClients.some(entry => client === undefined || entry.client === client)) {
    throw new RuntimeApiError("Route intent returned unresolved client failures or conflicts. Read status before retrying.", 409, null);
  }
  if (!read && client !== undefined && failedClients.length > 0) {
    console.error("Route status includes unresolved failures or conflicts for other clients; review their status.");
  }
}

export function handleRouteToCommand(argv: string[], deps: RouteToDeps = {}): Promise<number> {
  return runCliAction(() => routeToAction(argv, deps));
}
