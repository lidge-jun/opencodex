/** Local CLI reads/applies never relay management writes from a Child to its Home. */
import { readClientConnectionState } from "../client/state";
import { withLinkApply } from "../client/link-home";
import { projectHomeRouteIntent, ROUTE_CLIENT_IDS, type RouteClientId, type RouteClientIntent, type RouteClientOutcome } from "../link/route-intent";
import { initializeHomeRouteIntentDefaults, readHomeRouteIntentState } from "./home-route-intent";
import { routeToDeviceStatus, type RouteToDeviceStatus, type RouteToStatus } from "./route-to-status";
import { withDurableRouteNativeSettings } from "./route-to-live-settings";
import { readLocalRouteIntentOff, readRouteIntentReceipt, setLocalRouteIntentOff } from "../integrations/route-intent";
import type { LinkChildContext } from "../cli/link-child";
import type { OcxConfig } from "../types";

export function readHomeRouteToStatus(config: OcxConfig, version: string): RouteToDeviceStatus {
  const local = withDurableRouteNativeSettings(config);
  const document = projectHomeRouteIntent(local, version, "home", readHomeRouteIntentState(local));
  const receipt = readRouteIntentReceipt();
  return routeToDeviceStatus("home", "home", document, receipt?.outcomes ?? [], receipt?.appliedRouteIntentDigest ?? null);
}

/**
 * `onlyClient` is the client a single Home write decides: only that client is materialized on the
 * Home. For a native client the decision (`onlyIntent`, else the default Children inherit) is
 * written through the Home's native switch. A sync passes none and never writes a Home native
 * switch: each native client is refreshed to match the switch as it is.
 */
export async function syncHomeRouteTo(config: OcxConfig, version: string, overwriteConflict = false, overwriteClient?: RouteClientId, commit?: () => void,
  deps: { loadModels?: typeof import("../server/management/model-rows").loadExportModels; materialize?: typeof import("../client/route-intent-apply").materializeLocalRouteIntent;
    onlyClient?: RouteClientId; onlyIntent?: () => RouteClientIntent | undefined } = {}): Promise<RouteClientOutcome[]> {
  return withLinkApply(async () => {
    commit?.();
    const local = withDurableRouteNativeSettings(config);
    initializeHomeRouteIntentDefaults(local, version);
    const decidedIntent = deps.onlyIntent?.();
    const document = projectHomeRouteIntent(local, version, "home", readHomeRouteIntentState(local),
      { decidedClient: deps.onlyClient, ...(decidedIntent ? { decidedIntent } : {}) });
    const { loadExportModels } = await import("../server/management/model-rows");
    const { materializeLocalRouteIntent } = await import("../client/route-intent-apply");
    const materialize = deps.materialize ?? materializeLocalRouteIntent;
    const only = deps.onlyClient === undefined ? undefined : [deps.onlyClient];
    // A single-client write keeps the other clients' last proven outcomes in the Home receipt.
    const scope = only ? { retainSkippedOutcomes: true, decidedClient: deps.onlyClient } : {};
    const off = ROUTE_CLIENT_IDS.filter(client => !document.clients[client].enabled && (!only || only.includes(client)));
    await materialize(local, document, [], { overwriteConflict, overwriteClient, onlyClients: off, ...scope });
    const receipt = await materialize(local, document, await (deps.loadModels ?? loadExportModels)(local), { overwriteConflict, overwriteClient,
      ...(only ? { onlyClients: only } : {}), ...scope });
    return receipt.outcomes;
  });
}

function assertChild(context: LinkChildContext): void {
  const state = readClientConnectionState();
  if (state.kind !== "connected" || state.value.transport !== "link" || state.value.link?.linkId !== context.linkId) {
    throw new Error("The Remote Link connection changed; retry against the current device");
  }
}

export function readLocalRouteToStatus(context: LinkChildContext): RouteToStatus {
  assertChild(context);
  const receipt = readRouteIntentReceipt();
  if (!receipt) throw new Error("This Child has no recorded route intent. Run ocx route to sync to read and apply its Home intent");
  const stale = receipt.outcomes.filter(row => row.outcome === "stale").map(row => row.client);
  return { schema: "ocx.route-to/1", devices: [routeToDeviceStatus(context.linkId, "this", receipt.document,
    receipt.outcomes, receipt.appliedRouteIntentDigest, readLocalRouteIntentOff())],
    ...(receipt.catalogPending || stale.length ? { deferred: { reason: "intent_or_catalog_pending" as const, clients: stale } } : {}) };
}

export async function syncLocalRouteTo(context: LinkChildContext, overwriteConflict = false,
  deps: { sync?: typeof import("../client/connect").syncConnectedClient } = {}): Promise<RouteToStatus> {
  assertChild(context);
  const { syncConnectedClient } = await import("../client/connect");
  const result = await (deps.sync ?? syncConnectedClient)({ expect: { kind: "link", linkId: context.linkId }, overwriteConflict });
  const status = readLocalRouteToStatus(context);
  if (result.stale) status.deferred ??= { reason: "intent_or_catalog_pending", clients: status.devices[0]!.clients.filter(row => row.applied === "stale").map(row => row.client) };
  return status;
}

export async function setLocalRouteToOff(context: LinkChildContext, client: RouteClientId, off: boolean): Promise<RouteToStatus> {
  await withLinkApply(async () => {
    assertChild(context);
    setLocalRouteIntentOff(client, off);
  });
  // The existing sync takes the lifecycle/config locks and checks the pinned connection again.
  return syncLocalRouteTo(context);
}
