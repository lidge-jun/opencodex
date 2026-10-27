/**
 * What a Remote Link Child tells its Home about itself, and what the Home remembers of it.
 *
 * A Child sends its release version and its peer feature ids (`src/remote/features.ts`) as two
 * headers on the credential-free relay-auth challenge it already sends before every relayed
 * request (`src/client/link-relay-transport.ts`). The Home records them only after the caller
 * proof verifies, so an observation is bound to the link key; it is still the Child's own claim
 * and is used for display and compatibility verdicts, never for admission.
 *
 * A Home older than this report ignores the headers, and a Child older than it sends none: the
 * Home then knows only the relay-auth version the challenge itself names. Observations live in
 * the Home's memory and start empty after a restart; the next relayed request refills them.
 */
export const LINK_PEER_REPORT_VERSION = "1";
export const LINK_PEER_VERSION_HEADER = "x-opencodex-link-peer-version";
export const LINK_PEER_FEATURES_HEADER = "x-opencodex-link-peer-features";

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]{1,128})?$/;
const FEATURE_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;
const MAX_FEATURES = 64;
const MAX_LINKS = 256;

export interface LinkPeerReport {
  /** True when the challenge carried either report header, valid or not; false for a pre-report Child. */
  reported: boolean;
  version: string | null;
  features: string[] | null;
}

/** Header values a Child sends. Invalid input yields no header rather than a malformed one. */
export function linkPeerReportHeaders(version: string, features: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  if (RELEASE_VERSION.test(version)) headers[LINK_PEER_VERSION_HEADER] = version;
  const ids = parseFeatureList(features.join(","));
  if (ids) headers[LINK_PEER_FEATURES_HEADER] = ids.join(",");
  return headers;
}

function parseFeatureList(value: string | null): string[] | null {
  if (value === null || value === "") return null;
  const ids = value.split(",");
  if (ids.length > MAX_FEATURES || new Set(ids).size !== ids.length || ids.some(id => !FEATURE_ID.test(id))) return null;
  return ids;
}

/** Home side: read a report from challenge headers. Each field is dropped on its own when invalid. */
export function parseLinkPeerReport(headers: Headers): LinkPeerReport {
  const version = headers.get(LINK_PEER_VERSION_HEADER);
  const features = headers.get(LINK_PEER_FEATURES_HEADER);
  return {
    reported: version !== null || features !== null,
    version: version !== null && RELEASE_VERSION.test(version) ? version : null,
    features: parseFeatureList(features),
  };
}

export interface LinkPeerObservation extends LinkPeerReport {
  /** The relay-auth version of the verified challenge. */
  relayAuth: string;
  observedAt: string;
}

/** A challenge for a known link and key that named a relay-auth version this Home does not speak. */
export interface LinkPeerRefusal {
  relayAuth: string;
  refusedAt: string;
}

export interface LinkPeerEntry {
  observed: LinkPeerObservation | null;
  refused: LinkPeerRefusal | null;
}

export interface LinkPeerObservations {
  observe(linkId: string, relayAuth: string, report: LinkPeerReport): void;
  refuse(linkId: string, relayAuth: string): void;
  get(linkId: string): LinkPeerEntry;
}

export function createLinkPeerObservations(now: () => Date = () => new Date()): LinkPeerObservations {
  const entries = new Map<string, LinkPeerEntry>();
  const update = (linkId: string, change: Partial<LinkPeerEntry>) => {
    const current = entries.get(linkId) ?? { observed: null, refused: null };
    entries.delete(linkId);
    entries.set(linkId, { ...current, ...change });
    // Only known link ids reach here; the cap bounds memory if the store churns for a long time.
    if (entries.size > MAX_LINKS) entries.delete(entries.keys().next().value!);
  };
  return {
    observe(linkId, relayAuth, report) {
      update(linkId, { observed: { relayAuth, ...report, observedAt: now().toISOString() }, refused: null });
    },
    refuse(linkId, relayAuth) {
      update(linkId, { refused: { relayAuth, refusedAt: now().toISOString() } });
    },
    get(linkId) {
      return entries.get(linkId) ?? { observed: null, refused: null };
    },
  };
}
