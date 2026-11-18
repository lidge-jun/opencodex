import type { OcxConfig } from "../../types";
import { hasOwnProvider } from "../../config/provider-name";
import { getCachedProviderRoutingQuota } from "../../providers/quota-routing-cache";
import { PROVIDER_QUOTA_MAX_AGE_MS, type ProviderRoutingQuota } from "../../providers/quota-types";
import { cachedProviderQuotaIsExhausted } from "../../combos/resolve";

/**
 * Project cached inference evidence into the Combo editor routing quota.
 *
 * Only state, observation time and an exclusive `validUntil` leave the process: cached display
 * reports and private credential bindings are unchanged. A row that carries a timestamp but no
 * percentage or USD figure is not inference evidence, so it stays unknown.
 */
export function providerRoutingQuota(config: OcxConfig, name: string, now: number): ProviderRoutingQuota {
  const provider = hasOwnProvider(config.providers, name) ? config.providers[name] : undefined;
  const quota = getCachedProviderRoutingQuota(name, provider, now);
  if (!quota || !Number.isFinite(quota.updatedAt) || quota.updatedAt < 0 || quota.updatedAt > now
    || now >= quota.updatedAt + PROVIDER_QUOTA_MAX_AGE_MS) return { state: "unknown" };

  const percentages = [quota.fiveHourPercent, quota.weeklyPercent, quota.monthlyPercent,
    ...(quota.customWindows ?? []).filter(window => window.modelId === undefined).map(window => window.percent)];
  const hasPercentage = percentages.some(value => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const credits = quota.creditsUsd;
  const hasCredits = credits !== undefined && Number.isFinite(credits.percent)
    && credits.percent >= 0 && Number.isFinite(credits.remaining);
  if (!hasPercentage && !hasCredits) return { state: "unknown" };

  const state = cachedProviderQuotaIsExhausted(quota, now) ? "exhausted" : "available";
  let validUntil = quota.updatedAt + PROVIDER_QUOTA_MAX_AGE_MS;
  if (state === "exhausted") {
    const resets = [quota.fiveHourResetAt, quota.weeklyResetAt, quota.monthlyResetAt,
      ...(quota.customWindows ?? []).filter(window => window.modelId === undefined).map(window => window.resetAt)]
      .filter((reset): reset is number => typeof reset === "number" && Number.isFinite(reset)
        && reset > now && reset < validUntil)
      .sort((left, right) => left - right);
    // Reuse dispatch predicate: another exhausted window or USD cap may still block.
    for (const reset of resets) {
      if (!cachedProviderQuotaIsExhausted(quota, reset)) {
        validUntil = reset;
        break;
      }
    }
  }
  return { state, updatedAt: quota.updatedAt, validUntil };
}
