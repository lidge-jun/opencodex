import type { OcxConfig } from "../../types";
/** Home-owned route decisions. This management surface is never added to the link relay. */
import { jsonResponse } from "../auth-cors";
import { managementInferencePort, type ManagementContext } from "./context";
import { readManagementJsonBody, managementBodyTooLargeResponse } from "./body";
import { readLinkStore, type LinkRecord } from "../../link/store";
import { linkStorePath } from "../../link/paths";
import { homeLinkChildParity } from "../../link/child-parity";
import { homeRouteIntentWatch } from "../../link/route-intent-watch";
import { ROUTE_CLIENT_IDS, parseRouteClientIntent, projectHomeRouteIntent, type RouteClientId, type RouteClientIntent, type RouteClientOutcome } from "../../link/route-intent";
import { clearRouteClientIntent, setRouteClientIntent } from "../../routing/route-intent-state";
import { initializeHomeRouteIntentDefaults, readHomeRouteIntentState } from "../../routing/home-route-intent";
import { routeToDeviceStatus, type RouteToStatus } from "../../routing/route-to-status";
import { refreshRouteNativeSettings } from "../../routing/route-to-live-settings";

export interface RouteToRouteDeps {
  applyHome?: (ctx: ManagementContext, overwriteConflict: boolean, overwriteClient?: RouteClientId) => Promise<RouteClientOutcome[]>;
  /** Isolated transaction test seam; production uses the shared local materializer. */
  materializeHome?: (config: OcxConfig, version: string, overwriteConflict: boolean, overwriteClient?: RouteClientId) => Promise<RouteClientOutcome[]>;
  syncChild?: (link: LinkRecord, ctx: ManagementContext, overwriteConflict: boolean, overwriteClient?: RouteClientId) => Promise<{ state: "synced" | "failed" | "pending"; reason?: string }>;
}

function devices(ctx: ManagementContext): LinkRecord[] {
  // Unlike an empty store, unreadable trust metadata must never select another device.
  return (ctx.deps.readLinkStore?.() ?? readLinkStore(linkStorePath())).links;
}

function resolveDevice(value: string | undefined, links: LinkRecord[]): string | undefined {
  if (value === undefined) return undefined;
  if (value === "home" || value === "this") return "home";
  const match = links.find(link => link.id === value || link.alias === value);
  if (!match) throw new Error("unknown_device");
  return match.id;
}

async function view(ctx: ManagementContext, selected?: string): Promise<RouteToStatus> {
  const links = devices(ctx);
  const selection = selected === "all" ? "all" : resolveDevice(selected ?? "home", links);
  const rows: RouteToStatus["devices"] = [];
  if (selection === "all" || selection === "home") {
    const { readHomeRouteToStatus } = await import("../../routing/route-to-local");
    rows.push(await readHomeRouteToStatus(ctx.config, ctx.version));
  }
  for (const link of links) {
    if (selection !== "all" && selection !== link.id) continue;
    const peer = homeLinkChildParity.get(link.id);
    rows.push(routeToDeviceStatus(link.id, link.alias, projectHomeRouteIntent(ctx.config, ctx.version, link.id, readHomeRouteIntentState(ctx.config)),
      peer.routeClientOutcomes ?? [], peer.appliedRouteIntentDigest ?? null));
  }
  return { schema: "ocx.route-to/1", devices: rows };
}

async function applyHome(ctx: ManagementContext, overwriteConflict: boolean, deps: RouteToRouteDeps, overwriteClient?: RouteClientId): Promise<RouteClientOutcome[]> {
  if (deps.applyHome) return deps.applyHome(ctx, overwriteConflict, overwriteClient);
  const syncHomeRouteTo = deps.materializeHome ?? (await import("../../routing/route-to-local")).syncHomeRouteTo;
  const local = { ...ctx.config, port: managementInferencePort(ctx) };
  const outcomes = await syncHomeRouteTo(local, ctx.version, overwriteConflict, overwriteClient);
  refreshRouteNativeSettings(ctx.config);
  return outcomes;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function parseWrite(value: unknown): { client: RouteClientId; action: "on" | "off" | "inherit"; device?: string; intent: RouteClientIntent; overwriteConflict: boolean } | null {
  if (!record(value) || Object.keys(value).some(key => !["client", "action", "device", "accounts", "modelNames", "overwriteConflict"].includes(key))) return null;
  if (!(ROUTE_CLIENT_IDS as readonly unknown[]).includes(value.client) || typeof value.action !== "string" || !["on", "off", "inherit"].includes(value.action)) return null;
  if (value.device !== undefined && (typeof value.device !== "string" || !value.device.trim())) return null;
  if (value.overwriteConflict !== undefined && typeof value.overwriteConflict !== "boolean") return null;
  if (value.modelNames !== undefined && value.modelNames !== "alias" && value.modelNames !== "routed") return null;
  if (value.modelNames !== undefined && value.client !== "hermes" && value.client !== "commandcode") return null;
  if (value.action === "inherit" && (!value.device || value.accounts !== undefined || value.modelNames !== undefined || value.overwriteConflict !== undefined)) return null;
  if (value.action === "off" && value.overwriteConflict === true) return null;
  const intent = parseRouteClientIntent({ enabled: value.action === "on", ...(value.accounts === undefined ? {} : { accounts: value.accounts }),
    ...(value.modelNames === undefined ? {} : { modelNames: value.modelNames }) }, value.client as RouteClientId);
  if (!intent) return null;
  return { client: value.client as RouteClientId, action: value.action as "on" | "off" | "inherit",
    ...(value.device === undefined ? {} : { device: value.device as string }), overwriteConflict: value.overwriteConflict === true,
    intent };
}

/** Bounded body parsing and one device resolution precede every persisted write. */
export async function handleRouteToRoutes(ctx: ManagementContext, deps: RouteToRouteDeps = {}): Promise<Response | null> {
  const { url, req, config } = ctx;
  if (url.pathname !== "/api/route-to" && url.pathname !== "/api/route-to/sync") return null;
  const reply = (body: unknown, status = 200): Response => {
    const response = jsonResponse(body, status, req, config);
    response.headers.set("cache-control", "no-store");
    return response;
  };
  if (config.runtimeRole === "client") return reply({ error: "Route-to decisions are owned by the Home", code: "link_child_read_only" }, 403);
  try {
    if (url.pathname === "/api/route-to" && req.method === "GET") {
      if ([...url.searchParams.keys()].some(key => key !== "device") || url.searchParams.getAll("device").length > 1) return reply({ error: "invalid_request" }, 400);
      return reply(await view(ctx, url.searchParams.get("device") ?? undefined));
    }
    const sync = url.pathname === "/api/route-to/sync" && req.method === "POST";
    if (!sync && !(url.pathname === "/api/route-to" && req.method === "PUT")) return reply({ error: "method_not_allowed" }, 405);
    let body: unknown;
    try { body = await readManagementJsonBody(req); }
    catch (error) { return managementBodyTooLargeResponse(error, req, config) ?? reply({ error: "invalid_request" }, 400); }
    if (sync) {
      if (!record(body) || Object.keys(body).some(key => !["device", "overwriteConflict"].includes(key))
        || (body.device !== undefined && (typeof body.device !== "string" || !body.device.trim()))
        || (body.overwriteConflict !== undefined && typeof body.overwriteConflict !== "boolean")) return reply({ error: "invalid_request" }, 400);
      const links = devices(ctx);
      const selected = body.device === "all" ? "all" : resolveDevice(body.device as string | undefined ?? "home", links);
      if (selected === "all" || selected === "home") await applyHome(ctx, body.overwriteConflict === true, deps);
      const syncs: Array<{ id: string; state: string; reason?: string }> = [];
      for (const link of links) {
        if (selected !== "all" && selected !== link.id) continue;
        const run = deps.syncChild ?? (await import("../../routing/route-to-sync-child")).syncRouteToChild;
        syncs.push({ id: link.id, ...await run(link, ctx, body.overwriteConflict === true) });
      }
      return reply({ ...await view(ctx, body.device as string | undefined), syncs }, syncs.some(row => row.state === "failed") ? 502 : 200);
    }
    const write = parseWrite(body);
    if (!write) return reply({ error: "invalid_request" }, 400);
    const selected = resolveDevice(write.device, devices(ctx));
    initializeHomeRouteIntentDefaults(ctx.config, ctx.version, selected === undefined ? write.client : undefined);
    if (write.action === "inherit") clearRouteClientIntent(write.client, selected!);
    else setRouteClientIntent(write.client, write.intent, selected === "home" ? "home" : selected);
    // Notify only after the desired state committed, before any slower local materialization.
    if (selected === undefined) for (const link of devices(ctx)) homeRouteIntentWatch.notify(link.id);
    else if (selected !== "home") homeRouteIntentWatch.notify(selected);
    // A default is also the Home's desired state. A device write waits for that Child's tick.
    if (selected === undefined || selected === "home") await applyHome(ctx, write.overwriteConflict, deps, write.client);
    if (selected && selected !== "home" && write.overwriteConflict) {
      const link = devices(ctx).find(row => row.id === selected)!;
      const run = deps.syncChild ?? (await import("../../routing/route-to-sync-child")).syncRouteToChild;
      const result = await run(link, ctx, true, write.client);
      return reply({ ...await view(ctx, write.device), syncs: [{ id: selected, ...result }] }, result.state === "failed" ? 502 : 200);
    }
    return reply(await view(ctx, write.device));
  } catch (error) {
    if (error instanceof Error && error.message === "unknown_device") return reply({ error: "unknown device: use home, this, or a link id or alias from ocx link status", code: "unknown_device" }, 404);
    // Do not project paths, config bytes, or transport credentials from a local exception.
    return reply({ error: "Route-to state could not be read or applied; inspect the local integration status and retry", code: "route_to_failed" }, 500);
  }
}
