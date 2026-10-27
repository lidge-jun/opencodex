/**
 * Home and Child compatibility over a Remote Link.
 *
 * `LINK_PROTOCOL_RELEASES` is the published record of which release first spoke each part of the
 * link protocol. It is history, so it cannot be derived at run time; `tests/clients/link-peer-
 * compatibility.test.ts` holds every id to the live feature registry and every release to the
 * package version. The verdict uses only what the link carries: the relay-auth version of a
 * verified challenge and, from 2.91.0, the Child's own version and feature report
 * (`src/link/peer-report.ts`).
 */
import { LINK_RELAY_AUTH_VERSION } from "./relay-auth";
import { LINK_PEER_REPORT_VERSION, type LinkPeerEntry } from "./peer-report";

export interface LinkProtocolRelease {
  /** The peer feature id, as `GET /readyz` lists it. */
  readonly id: string;
  /** First release that speaks it on both sides of a link. */
  readonly since: string;
  readonly summary: string;
}

export const LINK_PEER_REPORT_FEATURE = `link-peer-report/${LINK_PEER_REPORT_VERSION}`;

export const LINK_PROTOCOL_RELEASES: readonly LinkProtocolRelease[] = [
  { id: "relay-auth/2", since: "2.69.0", summary: "Connection-bound relay authentication before every relayed request." },
  { id: "link-management-relay", since: "2.84.0", summary: "Read-only Home management and Home Codex settings for the Child." },
  { id: LINK_PEER_REPORT_FEATURE, since: "2.91.0", summary: "The Child reports its version and features on the relay challenge." },
];

export type LinkCompatibilityVerdict = "compatible" | "degraded" | "incompatible" | "unknown";

export interface LinkLocalPeer {
  version: string;
  relayAuth: string;
  features: string[];
}

export interface LinkPeerStatus {
  observedAt: string | null;
  /** The Child's reported release, or null when it predates the report. */
  version: string | null;
  /** For an unreported version: the oldest release the observed protocol implies, and the first that would report. */
  versionRange: { min: string | null; below: string } | null;
  relayAuth: string | null;
  features: string[] | null;
  compatibility: LinkCompatibilityVerdict;
  reasons: string[];
}

function releaseParts(version: string): number[] {
  return version.split(/[-+]/, 1)[0]!.split(".").map(part => Number(part));
}

export function compareReleases(a: string, b: string): number {
  const left = releaseParts(a), right = releaseParts(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

function sinceOf(id: string): string | null {
  return LINK_PROTOCOL_RELEASES.find(release => release.id === id)?.since ?? null;
}

function relayAuthNumber(value: string): number {
  return /^\d{1,4}$/.test(value) ? Number(value) : Number.NaN;
}

export function linkPeerStatus(local: LinkLocalPeer, entry: LinkPeerEntry): LinkPeerStatus {
  const { observed, refused } = entry;
  if (refused && (!observed || observed.observedAt <= refused.refusedAt)) {
    const newerChild = relayAuthNumber(refused.relayAuth) > relayAuthNumber(local.relayAuth);
    return {
      observedAt: refused.refusedAt, version: null, versionRange: null, relayAuth: refused.relayAuth, features: null,
      compatibility: "incompatible",
      reasons: [`The Child speaks relay-auth/${refused.relayAuth} and this Home speaks relay-auth/${local.relayAuth}, so relayed requests are refused. Upgrade the ${newerChild ? "Home" : "Child"}.`],
    };
  }
  if (!observed) {
    return {
      observedAt: null, version: null, versionRange: null, relayAuth: null, features: null,
      compatibility: "unknown", reasons: ["No relayed request from this Child since the Home started."],
    };
  }
  const base = { observedAt: observed.observedAt, relayAuth: observed.relayAuth, features: observed.features };
  if (!observed.reported) {
    return {
      ...base, version: null,
      versionRange: { min: sinceOf(`relay-auth/${observed.relayAuth}`), below: sinceOf(LINK_PEER_REPORT_FEATURE)! },
      compatibility: "compatible",
      reasons: [`relay-auth/${observed.relayAuth} matches. The Child does not report its version; it predates ${LINK_PEER_REPORT_FEATURE}.`],
    };
  }
  if (observed.version === null || observed.features === null) {
    // A reporting Child whose version or feature list was missing or rejected: the Home cannot tell what it uses.
    return {
      ...base, version: observed.version, versionRange: null, compatibility: "unknown",
      reasons: [`relay-auth/${observed.relayAuth} matches, but the Child's ${observed.version === null && observed.features === null ? "version and feature list were" : observed.version === null ? "version was" : "feature list was"} missing or invalid, so its features cannot be checked.`],
    };
  }
  const childOnly = observed.features.filter(id => !local.features.includes(id));
  if (childOnly.length > 0) {
    return {
      ...base, version: observed.version, versionRange: null, compatibility: "degraded",
      reasons: [`The Child (${observed.version}) uses ${childOnly.join(", ")}, which this Home (${local.version}) does not serve. Upgrade the Home.`],
    };
  }
  return {
    ...base, version: observed.version, versionRange: null, compatibility: "compatible",
    reasons: [compareReleases(observed.version, local.version) === 0 ? "Same release as this Home."
      : `relay-auth/${observed.relayAuth} matches and this Home (${local.version}) serves every feature the Child (${observed.version}) uses.`],
  };
}

export function localLinkPeer(version: string, features: readonly string[]): LinkLocalPeer {
  return { version, relayAuth: LINK_RELAY_AUTH_VERSION, features: [...features] };
}
