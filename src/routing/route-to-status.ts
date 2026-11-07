import { ROUTE_CLIENT_IDS, routeClientIntentDigest, routeIntentDigest, type HomeRouteIntentDocument, type RouteClientId, type RouteClientOutcome } from "../link/route-intent";

export interface RouteToClientStatus {
  client: RouteClientId;
  intent: "on" | "off";
  source: "builtin" | "default" | "device" | "local";
  applied: RouteClientOutcome["outcome"] | null;
  target?: string;
}

export interface RouteToDeviceStatus {
  id: string;
  alias: string;
  desiredDigest: string;
  appliedRouteIntentDigest: string | null;
  clients: RouteToClientStatus[];
}

export interface RouteToStatus {
  schema: "ocx.route-to/1";
  devices: RouteToDeviceStatus[];
  syncs?: Array<{ id: string; state: "synced" | "failed" | "pending"; reason?: string }>;
  deferred?: { reason: "intent_or_catalog_pending"; clients: RouteClientId[] };
}

/** Compare receipts with today's intent: an old successful apply is stale, never current. */
export function routeToDeviceStatus(
  id: string,
  alias: string,
  document: HomeRouteIntentDocument,
  outcomes: readonly RouteClientOutcome[],
  appliedDigest: string | null,
  localOff: readonly RouteClientId[] = [],
): RouteToDeviceStatus {
  const effective = structuredClone(document);
  for (const row of outcomes) {
    if (row.initialIntent && row.initialRevision === (document.clientRevisions?.[row.client] ?? 0)) {
      effective.clients[row.client] = { ...effective.clients[row.client], ...row.initialIntent };
      effective.sources[row.client] = "device";
    }
  }
  const desiredDigest = routeIntentDigest(effective);
  return {
    id, alias, desiredDigest, appliedRouteIntentDigest: appliedDigest,
    clients: ROUTE_CLIENT_IDS.map(client => {
      const outcome = outcomes.find(row => row.client === client);
      const disabledLocally = localOff.includes(client) || outcome?.source === "local";
      return {
        client,
        intent: disabledLocally ? "off" : effective.clients[client].enabled ? "on" : "off",
        source: disabledLocally ? "local" : effective.sources[client],
        applied: outcome?.outcome === "current" && !disabledLocally
          && (outcome.intentDigest ? outcome.intentDigest !== routeClientIntentDigest(effective, client) : desiredDigest !== appliedDigest) ? "stale" : outcome?.outcome ?? null,
        ...(outcome?.target ? { target: outcome.target } : {}),
      };
    }),
  };
}
