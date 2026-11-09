import { museUsageWindowsToQuota } from "../../providers/muse-subscription-usage";
import type { ProviderQuota } from "../../providers/quota-types";
import type { MuseMspConnection } from "./connection";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Translate MSP usage/read's observation without exposing its account-specific tier. */
export function museMspSubscriptionQuota(result: unknown): ProviderQuota | null {
  if (!record(result) || !record(result.usage)) return null;
  const usage = result.usage, observedAt = usage.observedAtMs;
  if (!Number.isSafeInteger(observedAt) || (observedAt as number) < 10_000_000_000 || (observedAt as number) > 8_640_000_000_000_000) return null;
  const window = record(usage.window) ? usage.window : undefined;
  const weekly = record(usage.weekly) ? usage.weekly : undefined;
  const toReset = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 10_000_000_000 ? value : undefined;
  const quota = museUsageWindowsToQuota({
    ...(window ? { window: { used_percent: window.usedPercent, resets_at: toReset(window.resetsAtMs), window_duration_mins: window.windowDurationMins } } : {}),
    ...(weekly ? { weekly: { used_percent: weekly.usedPercent, resets_at: toReset(weekly.resetsAtMs) } } : {}),
  });
  return quota ? { ...quota, updatedAt: observedAt as number } : null;
}

/** Quota observation is optional: unavailable usage must not discard a completed response. */
export async function observeMuseMspSubscriptionQuota(connection: Pick<MuseMspConnection, "request">,
  observe: (quota: ProviderQuota) => void, options: { timeoutMs: number; signal?: AbortSignal }): Promise<void> {
  if (options.signal?.aborted) return;
  try {
    const quota = museMspSubscriptionQuota(await connection.request("usage/read", {}, options));
    if (quota && !options.signal?.aborted) observe(quota);
  } catch { /* Quota observation must not alter the turn. */ }
}
