import type { AssetClass, ScopeMatch, ScopeResolution, SecurityScopeAsset, SecurityScopeExclusion } from "./types";

function stripTrailingDot(value: string): string {
  return value.replace(/\.+$/, "");
}

function stripWww(host: string): string {
  return host.replace(/^www\./, "");
}

export function normalizeAsset(assetClass: AssetClass, raw: string): string {
  const value = raw.trim();
  switch (assetClass) {
    case "domain":
    case "subdomain_pattern":
      return stripWww(stripTrailingDot(value.toLowerCase()));
    case "url_prefix": {
      try {
        const url = new URL(value);
        const host = url.port ? `${stripWww(url.hostname.toLowerCase())}:${url.port}` : stripWww(url.hostname.toLowerCase());
        const path = url.pathname.replace(/\/+$/, "") || "/";
        return `${url.protocol}//${host}${path}${url.search}`;
      } catch {
        return value.toLowerCase().replace(/\/+$/, "");
      }
    }
    case "ip":
      return value.toLowerCase();
    case "cidr":
      return value.replace(/\s+/g, "").toLowerCase();
    case "repository":
    case "mobile_app":
    case "api":
    case "smart_contract":
    case "local_lab":
    case "ctf_target":
      return value.toLowerCase();
    default:
      return value.toLowerCase();
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    n = (n << 8) + octet;
  }
  return n >>> 0;
}

function cidrContains(cidr: string, ip: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  if (!base || bitsRaw === undefined) return false;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const baseInt = ipv4ToInt(base);
  const ipInt = ipv4ToInt(ip);
  if (baseInt === null || ipInt === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (baseInt & mask) === (ipInt & mask);
}

function domainMatches(rule: string, host: string, wildcard: boolean): boolean {
  if (host === rule) return true;
  if (!wildcard) return host.endsWith(`.${rule}`);
  if (rule.startsWith("*.")) {
    const suffix = rule.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === rule || host.endsWith(`.${rule}`);
}

function hostOf(target: string): string | null {
  const trimmed = target.trim();
  try {
    const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return stripWww(stripTrailingDot(url.hostname.toLowerCase()));
  } catch {
    if (/^[a-z0-9.-]+$/i.test(trimmed)) return stripWww(stripTrailingDot(trimmed.toLowerCase()));
    return null;
  }
}

function ipOf(target: string): string | null {
  const host = hostOf(target);
  if (host && ipv4ToInt(host) !== null) return host;
  if (ipv4ToInt(target.trim()) !== null) return target.trim();
  return null;
}

export function assetMatches(asset: { asset_class: AssetClass; normalized_asset: string }, target: string): boolean {
  const normalizedTarget = normalizeAsset(asset.asset_class, target);
  switch (asset.asset_class) {
    case "domain": {
      const host = hostOf(target);
      return host ? domainMatches(asset.normalized_asset, host, false) : normalizedTarget === asset.normalized_asset;
    }
    case "subdomain_pattern": {
      const host = hostOf(target);
      return host ? domainMatches(asset.normalized_asset, host, true) : false;
    }
    case "url_prefix": {
      const cleanPrefix = asset.normalized_asset.replace(/\/+$/, "");
      return normalizedTarget === asset.normalized_asset || normalizedTarget === cleanPrefix || normalizedTarget.startsWith(`${cleanPrefix}/`);
    }
    case "ip":
      return ipOf(target) === asset.normalized_asset;
    case "cidr": {
      const ip = ipOf(target);
      return ip ? cidrContains(asset.normalized_asset, ip) : false;
    }
    case "local_lab":
    case "ctf_target":
    case "repository":
    case "mobile_app":
    case "api":
    case "smart_contract":
      return normalizedTarget === asset.normalized_asset || normalizedTarget.startsWith(`${asset.normalized_asset}/`);
    default:
      return normalizedTarget === asset.normalized_asset;
  }
}

/**
 * Deterministic scope matcher. Exclusions always win. Similarity (e.g. a
 * sibling subdomain) is NEVER treated as in-scope; the registry rule must
 * match. Unknown assets deny.
 */
export function resolveScope(
  target: string,
  assets: SecurityScopeAsset[],
  exclusions: SecurityScopeExclusion[],
  options: { expired?: boolean } = {},
): ScopeResolution {
  if (options.expired) {
    return { match: "EXPIRED", reason_code: "SCOPE_EXPIRED" };
  }

  const matchingExclusion = exclusions.find(ex => assetMatches(ex, target));
  if (matchingExclusion) {
    return { match: "EXCLUDED", exclusion: matchingExclusion, reason_code: "ASSET_EXCLUDED" };
  }

  const matchingAsset = assets.find(asset => assetMatches(asset, target));
  if (matchingAsset) {
    return { match: "IN_SCOPE", asset: matchingAsset, reason_code: "ASSET_IN_SCOPE" };
  }

  return { match: "UNKNOWN", reason_code: "UNKNOWN_ASSET" };
}

export function computeLeadPriority(components: {
  asset_criticality: number;
  evidence_strength: number;
  confidence: number;
  novelty: number;
  memory_signal: number;
  policy_risk_penalty: number;
  duplication_penalty: number;
}): number {
  return (
    components.asset_criticality
    + components.evidence_strength
    + components.confidence
    + components.novelty
    + components.memory_signal
    - components.policy_risk_penalty
    - components.duplication_penalty
  );
}
