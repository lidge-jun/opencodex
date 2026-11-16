import type { OcxConfig } from "../../types";
/** Home-owned route decisions. This management surface is never added to the link relay. */
import { jsonResponse } from "../auth-cors";
import { managementInferencePort, type ManagementContext } from "./context";
import { readManagementJsonBody, managementBodyTooLargeResponse } from "./body";
import { readLinkStore, type LinkRecord } from "../../link/store";
import { linkStorePath } from "../../link/paths";
import { homeLinkChildParity } from "../../link/child-parity";
import { homeRouteIntentWatch } from "../../link/route-intent-watch";
import { ROUTE_CLIENT_IDS, isHomeNativeRouteClient, parseRouteClientIntent, type HomeNativeRouteClientId, type RouteClientId, type RouteClientIntent, type RouteClientOutcome } from "../../link/route-intent";
import { clearRouteClientIntent, readRouteIntentState, recordHomeNativeDecision, RouteIntentStateUnreadableError, setRouteClientIntent } from "../../routing/route-intent-state";
import { HomeAsideIntentDerivationError, initializeHomeRouteIntentDefaults, readHomeRouteIntentStateAsideTolerant, reconcileHomeRouteDevices } from "../../routing/home-route-intent";
import { captureHomeRouteDefaults, homeHasLinks } from "../../routing/home-route-capture";
import { EPHEMERAL_NO_ROUTE_INTENT, routeToAsideUnresolved, routeToDeviceStatus, unsupportedRouteToDevice, type RouteToStatus, type RouteToSyncRow } from "../../routing/route-to-status";
import { projectHomeRouteIntent } from "../../link/route-intent";
import { refreshRouteNativeSettings, withDurableRouteNativeSettings } from "../../routing/route-to-live-settings";
import { withLinkApply, LinkApplyBusyError } from "../../client/link-home";
import { withConfigMutationLockSync } from "../../config/mutation-lock";

export interface RouteToRouteDeps {
  applyHome?: (ctx: ManagementContext, overwriteConflict: boolean, overwriteClient?: RouteClientId) => Promise<RouteClientOutcome[]>;
  /** Isolated transaction test seam; production uses the shared local materializer. */
  materializeHome?: (config: OcxConfig, version: string, overwriteConflict: boolean, overwriteClient?: RouteClientId) => Promise<RouteClientOutcome[]>;
  syncChild?: (link: LinkRecord, ctx: ManagementContext, overwriteConflict: boolean, overwriteClient?: RouteClientId) => Promise<Omit<RouteToSyncRow, "id">>;
}

function devices(ctx: ManagementContext): LinkRecord[] {
  // Unlike an empty store, unreadable trust metadata must never select another device.
  return (ctx.deps.readLinkStore?.() ?? readLinkStore(linkStorePath())).links;
}

/** An ephemeral ocx-child never reads route intent: nothing addresses it as a route device. */
function ephemeral(link: LinkRecord | undefined): boolean {
  return link?.childKind === "ephemeral";
}

function resolveDevice(value: string | undefined, links: LinkRecord[]): string | undefined {
  if (value === undefined) return undefined;
  if (value === "home" || value === "this") return "home";
  const exact = links.find(link => link.id === value);
  if (exact) return exact.id;
  const matches = links.filter(link => link.alias === value);
  if (matches.length > 1) throw new Error("ambiguous_device");
  if (!matches.length) throw new Error("unknown_device");
  return matches[0]!.id;
}

async function view(ctx: ManagementContext, selected?: string): Promise<RouteToStatus> {
  const links = devices(ctx);
  const selection = selected === "all" ? "all" : resolveDevice(selected ?? "home", links);
  const rows: RouteToStatus["devices"] = [];
  const warnings: string[] = [];
  if (selection === "all" || selection === "home") {
    const { readHomeRouteToStatus, HOME_ASIDE_UNRESOLVED_MESSAGE } = await import("../../routing/route-to-local");
    const home = readHomeRouteToStatus(ctx.config, ctx.version);
    if (home.clients.some(row => row.intent === "unresolved")) warnings.push(HOME_ASIDE_UNRESOLVED_MESSAGE);
    rows.push(home);
  }
  // Read once: a Child without its own Aside entry inherits the same unresolved default.
  let inherited: ReturnType<typeof readHomeRouteIntentStateAsideTolerant> | undefined;
  for (const link of links) {
    if (selection !== "all" && selection !== link.id) continue;
    if (ephemeral(link)) { rows.push(unsupportedRouteToDevice(link.id, link.alias)); continue; }
    const peer = homeLinkChildParity.get(link.id);
    inherited ??= readHomeRouteIntentStateAsideTolerant(ctx.config);
    const row = routeToDeviceStatus(link.id, link.alias, projectHomeRouteIntent(ctx.config, ctx.version, link.id, inherited.state),
      peer.routeClientOutcomes ?? [], peer.appliedRouteIntentDigest ?? null);
    rows.push(inherited.asideUnresolved && inherited.state.devices[link.id]?.aside === undefined ? routeToAsideUnresolved(row) : row);
  }
  return { schema: "ocx.route-to/1", devices: rows, ...(warnings.length ? { warnings } : {}) };
}

async function applyHome(ctx: ManagementContext, overwriteConflict: boolean, deps: RouteToRouteDeps, overwriteClient?: RouteClientId, commit?: () => void,
  onlyClient?: RouteClientId, onlyIntent?: () => RouteClientIntent | undefined, homeAsideDecision = false): Promise<RouteClientOutcome[]> {
  if (deps.applyHome) return withLinkApply(async () => { commit?.(); return deps.applyHome!(ctx, overwriteConflict, overwriteClient); });
  const { syncHomeRouteTo } = await import("../../routing/route-to-local");
  const local = { ...ctx.config, port: managementInferencePort(ctx) };
  const outcomes = deps.materializeHome
    ? await withLinkApply(async () => { commit?.(); return deps.materializeHome!(local, ctx.version, overwriteConflict, overwriteClient); })
    : await syncHomeRouteTo(local, ctx.version, overwriteConflict, overwriteClient, commit, { onlyClient, onlyIntent, homeAsideDecision });
  refreshRouteNativeSettings(ctx.config);
  return outcomes;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The Home's durable native switch for a client (absent is on), as another process may have left it. */
function durableHomeSwitch(config: OcxConfig, client: HomeNativeRouteClientId): boolean {
  const durable = withDurableRouteNativeSettings(config);
  return client === "claude" ? durable.claudeCode?.enabled !== false : durable.clientIntegrations?.[client] !== false;
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
  if (!["/api/route-to", "/api/route-to/sync"].includes(url.pathname)) return null;
  const reply = (body: unknown, status = 200): Response => {
    const response = jsonResponse(body, status, req, config);
    response.headers.set("cache-control", "no-store");
    return response;
  };
  const unsupported = (link: LinkRecord): Response => reply({ error: `${link.alias} runs the ephemeral ocx-child, which never reads route intent, so nothing was changed. ocx sync refreshes its Home catalog.`,
    code: "route_intent_unsupported", reason: EPHEMERAL_NO_ROUTE_INTENT, device: link.id }, 409);
  if (config.runtimeRole === "client") return reply({ error: "Route-to decisions are owned by the Home", code: "link_child_read_only" }, 403);
  let desiredCommitted = false;
  // A Home native decision is its switch: what the durable switch read before this write.
  let nativeBefore: { client: HomeNativeRouteClientId; enabled: boolean } | undefined;
  try {
    if (url.pathname === "/api/route-to" && req.method === "GET") {
      if ([...url.searchParams.keys()].some(key => key !== "device") || url.searchParams.getAll("device").length > 1) return reply({ error: "invalid_request" }, 400);
      return reply(await view(ctx, url.searchParams.get("device") ?? undefined));
    }
    if (url.pathname === "/api/route-to") {
      if (req.method !== "PUT") return reply({ error: "method_not_allowed" }, 405);
    }
    if (url.pathname === "/api/route-to/sync") {
      if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
    }
    const sync = url.pathname.endsWith("/sync");
    let body: unknown;
    try { body = await readManagementJsonBody(req); }
    catch (error) { return managementBodyTooLargeResponse(error, req, config) ?? reply({ error: "invalid_request" }, 400); }
    if (sync) {
      if (!record(body) || Object.keys(body).some(key => !["device", "overwriteConflict"].includes(key))
        || (body.device !== undefined && (typeof body.device !== "string" || !body.device.trim()))
        || (body.overwriteConflict !== undefined && typeof body.overwriteConflict !== "boolean")) return reply({ error: "invalid_request" }, 400);
      const links = devices(ctx);
      const selected = body.device === "all" ? "all" : resolveDevice(body.device as string | undefined ?? "home", links);
      const only = links.find(link => link.id === selected);
      if (ephemeral(only)) return unsupported(only!);
      if (selected === "all" || selected === "home") await applyHome(ctx, body.overwriteConflict === true, deps);
      const syncs: RouteToSyncRow[] = [];
      for (const link of links) {
        if (selected !== "all" && selected !== link.id) continue;
        if (ephemeral(link)) { syncs.push({ id: link.id, state: "unsupported", reason: EPHEMERAL_NO_ROUTE_INTENT }); continue; }
        const run = deps.syncChild ?? (await import("../../routing/route-to-sync-child")).syncRouteToChild;
        syncs.push({ id: link.id, ...await run(link, ctx, body.overwriteConflict === true) });
      }
      return reply({ ...await view(ctx, body.device as string | undefined), syncs }, syncs.some(row => row.state === "failed") ? 502 : 200);
    }
    const write = parseWrite(body);
    if (!write) return reply({ error: "invalid_request" }, 400);
    const selected = resolveDevice(write.device, devices(ctx));
    const target = devices(ctx).find(link => link.id === selected);
    if (ephemeral(target)) return unsupported(target!);
    // On the Home itself a native client's decision is its native switch, written by the apply below.
    const homeNative = selected === "home" && isHomeNativeRouteClient(write.client) ? write.client : undefined;
    const switchBefore = homeNative ? durableHomeSwitch(ctx.config, homeNative) : undefined;
    // `ocx route to aside on|off --device home` decides the Home alone. A plain default write
    // still refuses an unresolved Aside default, because that one decides what Children inherit.
    const homeAsideDecision = selected === "home" && write.client === "aside" && write.action !== "inherit";
    if (homeNative) nativeBefore = { client: homeNative, enabled: switchBefore! };
    const commit = () => withConfigMutationLockSync(() => {
      // A Home native decision on a Home with no link is only its switch: like every Home-only
      // switch writer there, it leaves route-intent.json alone. Until defaults are saved a Home
      // inherit takes the builtin.
      const routeIntentUntouched = homeNative !== undefined && !homeHasLinks();
      if (!routeIntentUntouched) {
        reconcileHomeRouteDevices(devices(ctx).map(link => link.id));
        // A Home-only decision captures the Children's native defaults only once the Home has a link.
        // An explicit Home Aside decision must not guess a Child default from unresolved ownership.
        const asideDecided = homeAsideDecision || (write.client === "aside" && readRouteIntentState().devices.home?.aside !== undefined);
        if (!asideDecided) {
          initializeHomeRouteIntentDefaults(withDurableRouteNativeSettings(ctx.config), ctx.version, selected === undefined ? write.client : undefined,
            { whenLinked: selected === "home" });
        } else if (selected === "home") {
          // Capture resolvable ownership before applying the Home decision can change it.
          try { initializeHomeRouteIntentDefaults(withDurableRouteNativeSettings(ctx.config), ctx.version, undefined, { whenLinked: true }); }
          catch (error) {
            if (!(error instanceof HomeAsideIntentDerivationError)) throw error;
            captureHomeRouteDefaults(undefined, { whenLinked: true });
          }
        }
      }
      if (homeNative) { if (!routeIntentUntouched) recordHomeNativeDecision(homeNative); }
      else if (write.action === "inherit") clearRouteClientIntent(write.client, selected!);
      else setRouteClientIntent(write.client, write.intent, selected);
      // A Home native decision is committed only once the apply writes its switch (below).
      if (!homeNative) desiredCommitted = true;
      // Desired state remains committed if subsequent reconciliation fails.
      if (selected === undefined) for (const link of devices(ctx)) { if (!ephemeral(link)) homeRouteIntentWatch.notify(link.id); }
      else if (selected !== "home") homeRouteIntentWatch.notify(selected);
    });
    // A default is also the Home's desired state. A device write waits for that Child's tick.
    // A Home inherit for a native client sets its switch to the default Children inherit.
    let decided: RouteClientOutcome | undefined;
    if (selected === undefined || selected === "home") {
      decided = (await applyHome(ctx, write.overwriteConflict, deps, write.client, commit, write.client,
        homeNative && write.action !== "inherit" ? () => write.intent : undefined, homeAsideDecision)).find(row => row.client === write.client);
    } else commit();
    if (selected && selected !== "home" && write.overwriteConflict) {
      const link = devices(ctx).find(row => row.id === selected)!;
      const run = deps.syncChild ?? (await import("../../routing/route-to-sync-child")).syncRouteToChild;
      const result = await run(link, ctx, true, write.client);
      return reply({ ...await view(ctx, write.device), syncs: [{ id: selected, ...result }] }, result.state === "failed" ? 502 : 200);
    }
    const status = await view(ctx, write.device);
    if (decided?.outcome === "conflict" || decided?.outcome === "failed") {
      // A refused or failed native apply leaves the Home switch, and so the rebuilt row, as it was.
      // Report this apply's own outcome rather than the rebuilt row's stale reading of it.
      const row = status.devices.find(device => device.id === "home")?.clients.find(entry => entry.client === write.client);
      if (row) row.applied = decided.outcome;
      const detail = decided.message ? `: ${decided.message}` : "";
      // A Home native decision is its switch. Most refusals come after the apply saved it (an
      // external Codex provider, an incomplete Grok block, a changed Desktop profile), so the durable
      // switch, not the outcome, says whether anything was saved. First-party Desktop refuses first.
      if (homeNative) {
        const saved = durableHomeSwitch(ctx.config, homeNative) !== switchBefore;
        return reply({ ...status, error: saved
          ? `The Home's ${write.client} switch was saved, but applying it ended in ${decided.outcome}${detail}`
          : `The Home did not apply ${write.client} (${decided.outcome})${detail}`,
        code: "route_apply_unresolved", desiredCommitted: saved }, 409);
      }
      // A default or a non-native devices.home override is route policy saved before the apply.
      return reply({ ...status, error: `${desiredCommitted ? "Route policy was saved, but the" : "The"} Home did not apply ${write.client} (${decided.outcome})${detail}`,
        code: "route_apply_unresolved", desiredCommitted }, 409);
    }
    return reply(status);
  } catch (error) {
    if (error instanceof LinkApplyBusyError) return reply({ error: desiredCommitted
      ? "Route policy was committed, but local apply is busy; retry sync"
      : "Another Home apply is running; no route policy was written", code: "route_apply_busy", desiredCommitted }, 409);
    // Names the file the operator has to fix or remove; nothing else from the local exception.
    if (error instanceof RouteIntentStateUnreadableError) return reply({ error: desiredCommitted
      ? `Route policy was saved, but route intent in ${error.path} could not be read afterwards. Inspect it, fix or remove it, then retry sync.`
      : error.message, code: "route_intent_unavailable", desiredCommitted }, 500);
    if (error instanceof Error && error.message === "ambiguous_device") return reply({ error: "ambiguous device alias: use an exact link id", code: "ambiguous_device" }, 409);
    if (error instanceof Error && error.message === "unknown_device") return reply({ error: "unknown device: use home, this, or a link id or alias from ocx link status", code: "unknown_device" }, 404);
    // Do not project paths, config bytes, or transport credentials from a local exception. Say
    // what was saved before the failure: route policy, or the Home's native switch.
    let switchSaved = false;
    try { switchSaved = nativeBefore !== undefined && durableHomeSwitch(ctx.config, nativeBefore.client) !== nativeBefore.enabled; }
    catch { /* An unreadable switch proves nothing was saved. */ }
    const saved = desiredCommitted || switchSaved;
    return reply({ error: switchSaved ? `The Home's ${nativeBefore!.client} switch was saved, but applying it failed; inspect the local integration status and retry sync`
      : desiredCommitted ? "Route policy was saved, but applying it failed; inspect the local integration status and retry sync"
        : "Route-to state could not be read or applied; inspect the local integration status and retry", code: "route_to_failed", desiredCommitted: saved }, 500);
  }
}
