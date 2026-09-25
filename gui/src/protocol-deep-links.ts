/**
 * Hash deep links between the protocol views: the plan preview and the Logs trace open the
 * compatibility matrix prefiltered to one protocol pair, and the plan preview opens one
 * provider's settings.
 *
 * The state lives in the hash query (`#models/compatibility?inbound=chat&upstream=messages`,
 * `#providers?provider=<name>`), which `app-routing.ts` keeps for exactly these two routes. A
 * link is a deliberate navigation (`navigateHash` pushes a history entry), so Back returns to
 * the view the link was followed from and Forward restores the prefilter.
 */
import { isProtocol, type Protocol, type UpstreamWire } from "../../src/protocols/contract";
import { navigateHash, normalizeHashPath, splitHashQuery } from "./hash-routing";

export const COMPATIBILITY_HASH = "models/compatibility";
export const PROVIDERS_HASH = "providers";

/** Longest provider name a deep link carries; the server bounds the same parameter at 200. */
const PROVIDER_NAME_LIMIT = 200;

export interface ProtocolPairFilter {
  inbound: Protocol | "";
  upstream: Protocol | "";
}

export const EMPTY_PROTOCOL_PAIR: ProtocolPairFilter = { inbound: "", upstream: "" };

/** A plan or trace upstream as a filter value; `other` has no Lab protocol identity. */
export function protocolPairUpstream(upstream: UpstreamWire | undefined): Protocol | "" {
  return upstream !== undefined && isProtocol(upstream) ? upstream : "";
}

export function compatibilityPairHash(pair: Partial<ProtocolPairFilter>): string {
  const query = new URLSearchParams();
  if (pair.inbound) query.set("inbound", pair.inbound);
  if (pair.upstream) query.set("upstream", pair.upstream);
  const text = query.toString();
  return text ? `${COMPATIBILITY_HASH}?${text}` : COMPATIBILITY_HASH;
}

function readQuery(hash: string, path: string): URLSearchParams | null {
  const parts = splitHashQuery(normalizeHashPath(hash));
  return parts.path === path ? new URLSearchParams(parts.query) : null;
}

/**
 * The pair a compatibility hash asks for, or `null` when the hash is not the compatibility
 * route (another tab's hash must not clear a filter the matrix still shows). Unknown values
 * read as "any".
 */
export function readCompatibilityPair(hash: string = window.location.hash): ProtocolPairFilter | null {
  const query = readQuery(hash, COMPATIBILITY_HASH);
  if (!query) return null;
  const inbound = query.get("inbound");
  const upstream = query.get("upstream");
  return {
    inbound: isProtocol(inbound) ? inbound : "",
    upstream: isProtocol(upstream) ? upstream : "",
  };
}

export function providerSettingsHash(provider: string): string {
  return `${PROVIDERS_HASH}?${new URLSearchParams({ provider }).toString()}`;
}

/** The provider a providers hash names, or `null`. */
export function readProviderSettingsTarget(hash: string = window.location.hash): string | null {
  const name = readQuery(hash, PROVIDERS_HASH)?.get("provider")?.trim() ?? "";
  return name && name.length <= PROVIDER_NAME_LIMIT ? name : null;
}

export function openCompatibilityPair(pair: Partial<ProtocolPairFilter>): void {
  navigateHash(compatibilityPairHash(pair));
}

export function openProviderSettings(provider: string): void {
  navigateHash(providerSettingsHash(provider));
}
