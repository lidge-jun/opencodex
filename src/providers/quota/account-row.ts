import { getAccountCredential } from "../../oauth/store";
import type { OcxProviderConfig } from "../../types";
import { isAnthropicInstanceId } from "../anthropic-instance-id";
import {
  explicitAccountReader, explicitQuotaIdentity, normalizeAnthropicQuota,
  type AccountQuotaCacheEntry, type ProviderAccountQuota,
} from "./account-cache";

/** Preserve private ownership fences until management's final publication check. */
export function projectAccountQuotaRow(
  provider: string,
  accountId: string,
  entry: AccountQuotaCacheEntry,
  providerConfig?: OcxProviderConfig,
): ProviderAccountQuota {
  const result: ProviderAccountQuota = {
    accountId,
    quota: isAnthropicInstanceId(provider) ? normalizeAnthropicQuota(entry.quota, Date.now()) : entry.quota,
    ...(entry.unavailable ? { unavailable: true as const } : {}),
    ...(entry.unavailable && entry.quotaFailure && entry.quotaFailureIsCurrent?.() === true ? { quotaFailure: entry.quotaFailure } : {}),
  };
  if (entry.quotaFailureIsCurrent) Object.defineProperty(result, "quotaFailureIsCurrent", { value: entry.quotaFailureIsCurrent });
  if (explicitAccountReader(provider)) {
    const identity = entry.identity;
    Object.defineProperty(result, "isCurrent", { value: () => {
      if (entry.isCurrent) return entry.isCurrent();
      const credential = getAccountCredential(provider, accountId);
      return !!credential && (!identity || explicitQuotaIdentity(provider, accountId, providerConfig) === identity);
    } });
  } else if (entry.isCurrent) {
    Object.defineProperty(result, "isCurrent", { value: entry.isCurrent });
  }
  return result;
}
