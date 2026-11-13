import { ROUTE_CLIENT_IDS, routeClientIntentDigest, routeIntentDigest, type HomeRouteIntentDocument, type RouteClientId, type RouteClientOutcome } from "../link/route-intent";

export interface RouteToClientStatus {
  client: RouteClientId;
  /**
   * `unresolved`: only Aside, on a device that follows the Children's Aside default while the Home's
   * existing Aside ownership cannot be named by stable userIds. Nothing decides it yet, so it is
   * neither on nor off; the status carries a warning saying how to resolve it.
   */
  intent: "on" | "off" | "unresolved";
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
  /**
   * Present only on a device that never reads route intent: an ephemeral `ocx-child` refreshes the
   * Home catalog through ocx sync and nothing else, so it has no client rows.
   */
  routeIntent?: "unsupported";
  reason?: typeof EPHEMERAL_NO_ROUTE_INTENT;
}

/** Why an ephemeral `ocx-child` link has no route intent. */
export const EPHEMERAL_NO_ROUTE_INTENT = "ephemeral-child-no-route-intent" as const;

export type RouteToSyncRow = { id: string; state: "synced" | "failed" | "pending" | "unsupported"; reason?: string };

export interface RouteToStatus {
  schema: "ocx.route-to/1";
  devices: RouteToDeviceStatus[];
  syncs?: RouteToSyncRow[];
  deferred?: { reason: "intent_or_catalog_pending"; clients: RouteClientId[] };
  /** Actionable notices about clients the request left alone, such as unresolved Aside on the Home. */
  warnings?: string[];
}

/** The status row of an ephemeral Child: route intent is unsupported, never stale or pending. */
export function unsupportedRouteToDevice(id: string, alias: string): RouteToDeviceStatus {
  return { id, alias, desiredDigest: "", appliedRouteIntentDigest: null, clients: [], routeIntent: "unsupported", reason: EPHEMERAL_NO_ROUTE_INTENT };
}

/** Report a device's Aside row as unresolved: its projected placeholder is not a decision. */
export function routeToAsideUnresolved(device: RouteToDeviceStatus): RouteToDeviceStatus {
  return { ...device, clients: device.clients.map(row => row.client === "aside"
    ? { client: "aside", intent: "unresolved", source: row.source, applied: null } : row) };
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
