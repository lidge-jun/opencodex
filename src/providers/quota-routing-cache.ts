import type { ProviderQuota, ProviderQuotaReport } from "./quota";

const quotaCache = new Map<string, ProviderQuota>();

export function clearCachedProviderQuotas(): void {
  quotaCache.clear();
}

export function replaceCachedProviderQuotas(reports: ProviderQuotaReport[]): void {
  quotaCache.clear();
  for (const report of reports) {
    // Native Desktop account snapshots are display-only, not an automatic routing policy.
    if (report.source === "zcode-desktop") continue;
    quotaCache.set(report.provider, report.quota);
  }
}

export function getCachedProviderQuota(
  provider: string,
  now: number,
  maxAgeMs = 30 * 60_000,
): ProviderQuota | null {
  const quota = quotaCache.get(provider);
  if (!quota) return null;
  if (now - quota.updatedAt > maxAgeMs) return null;
  return quota;
}

export function setCachedProviderQuotaForTests(
  provider: string,
  quota: ProviderQuota,
): void {
  quotaCache.set(provider, quota);
}
