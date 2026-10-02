/** 7d_oi attribution is fixture-confirmed for Fable; it is not a future-family wildcard. */
import type { ProviderQuotaWindow } from "../quota-types";
export function parseAnthropicFamilyHeaders(headers: Headers, now: number): ProviderQuotaWindow[] {
  const value = headers.get("anthropic-ratelimit-unified-7d_oi-utilization")?.trim();
  const rejected = headers.get("anthropic-ratelimit-unified-7d_oi-status")?.trim() === "rejected";
  const numeric = value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : undefined;
  // The observed overage fixture is 1.01; spent evidence clamps to the display ceiling.
  const percent = numeric !== undefined && Number.isFinite(numeric) && numeric >= 0 && numeric <= 1.01
    ? Math.min(100, Math.round(numeric * 10_000) / 100) : rejected ? 100 : undefined;
  if (percent === undefined) return [];
  const rawReset = headers.get("anthropic-ratelimit-unified-7d_oi-reset")?.trim();
  const resetAt = rawReset && /^\d+(?:\.\d+)?$/.test(rawReset) ? Number(rawReset) * 1000 : undefined;
  return [{ label: "Fable", scope: "model", percent, passiveObservedAt: now, ...(rejected ? { rejected: true as const } : {}),
    ...(resetAt !== undefined && resetAt > 0 && Number.isFinite(new Date(resetAt).getTime()) ? { resetAt } : {}) }];
}
export function mergeAnthropicFamilyWindows(previous: ProviderQuotaWindow[] = [], observed: ProviderQuotaWindow[] = []): ProviderQuotaWindow[] {
  return [...previous.filter(window => !observed.some(update => update.label === window.label && update.scope === window.scope)), ...observed];
}

const enumerated = new WeakSet<object>();
export function markAnthropicFamilyEnumeration<T extends object>(quota: T, authoritative: boolean): T {
  if (authoritative) enumerated.add(quota);
  return quota;
}
export function hasAnthropicFamilyEnumeration(quota: object): boolean { return enumerated.has(quota); }
