/**
 * The one registry of peer-visible features this build serves, advertised in `GET /readyz`
 * `features` so a Hub, a Child or GOAT decides compatibility by feature instead of parsing versions.
 *
 * Every entry reads the module that owns the capability; nothing here restates a fact by hand:
 *
 * - `quota-pool/1` when the management route registry declares `GET /api/quota-pool`. The registry
 *   is reconciled against dispatch source (`tests/server/management-route-registry.test.ts`), so the
 *   feature appears exactly when the route is reachable.
 * - `fallback-policy/1` when the registry declares `GET /api/fallback` (OCX-11). GOAT reads a Home
 *   without it as "fallback state unknown".
 * - `link-management-relay` when the Remote Link management read table is non-empty.
 * - `served-by-header` when the served-by emitter says responses carry the header.
 * - `relay-auth/<n>` with the connection-bound link relay auth version.
 * - `link-peer-report/<n>` with the version of the report a Child sends on the relay challenge and a
 *   Home records for `ocx link status` (`src/link/peer-report.ts`).
 * - `link-request-zstd/<n>` when this build decodes zstd request bodies a Child sends over the link
 *   and compresses its own as a Child (`src/link/request-compression.ts`).
 *
 * The ids are static strings. They carry no account, credential or configuration data, which is
 * what keeps the unauthenticated `/readyz` body safe. `parseRemoteReadyMetadata` accepts at most
 * 64 unique ids of at most 80 characters, and `tests/server/readyz-features.test.ts` holds the
 * full registry to that.
 */
import { LINK_MANAGEMENT_READ_PATHS } from "../link/management-routes";
import { LINK_PEER_REPORT_VERSION } from "../link/peer-report";
import { LINK_RELAY_AUTH_VERSION } from "../link/relay-auth";
import { LINK_REQUEST_ZSTD_FEATURE, LINK_REQUEST_ZSTD_VERSION } from "../link/request-compression";
import { MANAGEMENT_ROUTES, type ManagementRoute } from "../server/management/route-registry";
import { SERVED_BY_HEADER_EMITTED } from "./served-by";

export const QUOTA_POOL_PATH = "/api/quota-pool";
export const FALLBACK_STATE_PATH = "/api/fallback";

/** The owning sources the registry reads. Tests pass their own to drive presence and absence. */
export interface PeerFeatureSources {
  readonly managementRoutes: readonly Pick<ManagementRoute, "method" | "path">[];
  readonly linkManagementReadPaths: readonly string[];
  readonly servedByHeaderEmitted: boolean;
  readonly relayAuthVersion: string;
  readonly linkPeerReportVersion: string;
  /** Empty when the build does not speak per-body zstd over a link. */
  readonly linkRequestZstdVersion: string;
}

/** One feature: its id when the sources say it is served, otherwise null. */
export type PeerFeature = (sources: PeerFeatureSources) => string | null;

/** Ordered; `/readyz` lists the served ids in this order. */
export const PEER_FEATURES: readonly PeerFeature[] = [
  s => s.managementRoutes.some(route => route.method === "GET" && route.path === QUOTA_POOL_PATH) ? "quota-pool/1" : null,
  s => s.managementRoutes.some(route => route.method === "GET" && route.path === FALLBACK_STATE_PATH) ? "fallback-policy/1" : null,
  s => s.linkManagementReadPaths.length > 0 ? "link-management-relay" : null,
  s => s.servedByHeaderEmitted ? "served-by-header" : null,
  s => `relay-auth/${s.relayAuthVersion}`,
  s => `link-peer-report/${s.linkPeerReportVersion}`,
  s => s.linkRequestZstdVersion ? `link-request-zstd/${s.linkRequestZstdVersion}` : null,
];

export function currentPeerFeatureSources(): PeerFeatureSources {
  return {
    managementRoutes: MANAGEMENT_ROUTES,
    linkManagementReadPaths: LINK_MANAGEMENT_READ_PATHS,
    servedByHeaderEmitted: SERVED_BY_HEADER_EMITTED,
    relayAuthVersion: LINK_RELAY_AUTH_VERSION,
    linkPeerReportVersion: LINK_PEER_REPORT_VERSION,
    linkRequestZstdVersion: LINK_REQUEST_ZSTD_VERSION,
  };
}

export function servedPeerFeatures(sources: PeerFeatureSources = currentPeerFeatureSources()): string[] {
  return PEER_FEATURES.map(feature => feature(sources)).filter((id): id is string => id !== null);
}

let buildFeatures: readonly string[] | undefined;

/** This build's served features. The sources are build constants, so the list is computed once. */
export function buildPeerFeatures(): string[] {
  buildFeatures ??= Object.freeze(servedPeerFeatures());
  return [...buildFeatures];
}

/**
 * The features a Home names to its Children on every relay-auth answer. `linkRequestCompression:
 * false` leaves out per-body zstd, so Children send identity bodies exactly as before it existed;
 * the Home still decodes a zstd body any client sends, and `GET /readyz` still lists what the build can do.
 */
export function linkHomeFeatures(config: { linkRequestCompression?: boolean } | undefined): string[] {
  const features = buildPeerFeatures();
  return config?.linkRequestCompression === false ? features.filter(id => id !== LINK_REQUEST_ZSTD_FEATURE) : features;
}
