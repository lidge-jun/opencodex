import { ROUTE_CLIENT_IDS, routeClientIntentDigest, routeIntentDigest, type HomeRouteIntentDocument, type RouteClientId, type RouteClientOutcome } from "../link/route-intent";

export interface RouteToClientStatus {
  client: RouteClientId;
  intent: "on" | "off";
  /** `native`: a Home row governed by the Home's own persisted native switch. */
  source: "builtin" | "default" | "device" | "native" | "local";
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

/**
 * Compare receipts with today's intent: an outcome recorded for an earlier intent is stale, never
 * current. That includes an earlier conflict or failure, which says nothing about the new intent.
 */
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
      // A receipt without per-client digests only proves its whole-document digest for current rows.
      const outdated = outcome !== undefined && !disabledLocally && outcome.outcome !== "stale"
        && (outcome.intentDigest ? outcome.intentDigest !== routeClientIntentDigest(effective, client)
          : outcome.outcome === "current" && desiredDigest !== appliedDigest);
      return {
        client,
        intent: disabledLocally ? "off" : effective.clients[client].enabled ? "on" : "off",
        source: disabledLocally ? "local" : effective.sources[client],
        applied: outdated ? "stale" : outcome?.outcome ?? null,
        ...(outcome?.target ? { target: outcome.target } : {}),
      };
    }),
  };
}
