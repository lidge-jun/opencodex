import { createHash } from "node:crypto";
import type { OcxProviderConfig } from "../types";
import type { ProviderQuota, ProviderQuotaReport } from "./quota";
import { providerUsesKeyAuthOverride, resolveProviderApiKey } from "./key-store";
import { getProviderRegistryEntry } from "./registry";
import { PROVIDER_QUOTA_MAX_AGE_MS } from "./quota-types";

export interface ProviderQuotaRoutingEvidence {
  quota: ProviderQuota;
  binding: string;
}

type CachedQuota = {
  quota: ProviderQuota;
  routing?: ProviderQuotaRoutingEvidence | { quota: ProviderQuota; testOnly: true };
};

const quotaCache = new Map<string, CachedQuota>();

/** Private cache identity; neither key material nor this digest enters management reports. */
export function providerQuotaRoutingBinding(
  name: string,
  provider: OcxProviderConfig,
  credential = resolveProviderApiKey(provider.apiKey)?.trim(),
): string | null {
  if ((provider.authMode ?? "key") !== "key" || !credential) return null;
  // Registry-owned OAuth/forward rows normalize saved authMode before dispatch.
  // A key probe must not constrain that later account selection.
  const entry = getProviderRegistryEntry(name);
  if (entry && (entry.authKind === "oauth" || entry.authKind === "forward")
    && !providerUsesKeyAuthOverride(entry, provider, credential)) return null;
  // Static auth headers can replace or combine with the probed API-key header.
  // Its semantics belong to the adapter, so it is not provider-wide quota evidence.
  if (Object.keys(provider.headers ?? {}).some(header =>
    ["authorization", "x-api-key", "x-goog-api-key"].includes(header.toLowerCase()))) return null;
  return createHash("sha256").update(JSON.stringify([
    name, provider.adapter, provider.baseUrl, credential,
  ])).digest("hex");
}

export function clearCachedProviderQuotas(): void {
  quotaCache.clear();
}

export function replaceCachedProviderQuotas(
  reports: ProviderQuotaReport[],
  routingEvidence?: WeakMap<ProviderQuotaReport, ProviderQuotaRoutingEvidence>,
): void {
  quotaCache.clear();
  for (const report of reports) {
    quotaCache.set(report.provider, { quota: report.quota, routing: routingEvidence?.get(report) });
  }
}

export function getCachedProviderQuota(
  provider: string,
  now: number,
  maxAgeMs = PROVIDER_QUOTA_MAX_AGE_MS,
): ProviderQuota | null {
  const quota = quotaCache.get(provider)?.quota;
  if (!quota) return null;
  if (now - quota.updatedAt > maxAgeMs) return null;
  return quota;
}

/** Only inference-wide evidence for this sole credential may rank or veto a whole provider. */
export function getCachedProviderRoutingQuota(
  name: string,
  provider: OcxProviderConfig | undefined,
  now: number,
  maxAgeMs = PROVIDER_QUOTA_MAX_AGE_MS,
): ProviderQuota | null {
  if (!provider || provider.disabled === true || (provider.authMode ?? "key") !== "key") return null;
  // An active-key report cannot speak for the other keys the dispatcher may select.
  if ((provider.apiKeyPool?.length ?? 0) > 1) return null;
  const routing = quotaCache.get(name)?.routing;
  if (!routing || !Number.isFinite(routing.quota.updatedAt) || routing.quota.updatedAt < 0
    || routing.quota.updatedAt > now || now - routing.quota.updatedAt >= maxAgeMs) return null;
  const binding = providerQuotaRoutingBinding(name, provider);
  if (!binding || (!("testOnly" in routing) && routing.binding !== binding)) return null;
  return routing.quota;
}

export function setCachedProviderQuotaForTests(
  provider: string,
  quota: ProviderQuota,
): void {
  // Unit tests deliberately assert the supplied quota's scope. Production publication
  // requires the producer's private, credential-bound evidence map above.
  quotaCache.set(provider, { quota, routing: { quota, testOnly: true } });
}
