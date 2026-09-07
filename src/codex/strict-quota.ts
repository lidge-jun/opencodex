import type { OcxConfig } from "../types";
import { getStrictAccountQuota } from "./quota";

export const CODEX_STRICT_QUOTA_FRESHNESS_MS = 5 * 60_000;
export type CodexStrictQuotaConfig = Pick<OcxConfig, "codexAccountStrictQuota" | "autoSwitchThreshold">;
type QuotaScope = "shared" | "spark" | "reserve";
export type CodexStrictQuotaStatus = {
  state: "off" | "unknown" | "ready" | "blocked";
  threshold?: number;
  usedPercent?: number;
  resetAt?: number;
  updatedAt?: number;
};
export function isCodexStrictQuotaEnabled(config: CodexStrictQuotaConfig, quotaScope?: QuotaScope): boolean {
  const threshold = config.autoSwitchThreshold ?? 80;
  // Independent scopes have separate admission authority and no ordinary-quota evidence.
  return config.codexAccountStrictQuota === true && Number.isFinite(threshold) && threshold > 0
    && (quotaScope === undefined || quotaScope === "shared");
}
export function getCodexStrictQuotaStatus(
  config: CodexStrictQuotaConfig, accountId: string, quotaScope?: QuotaScope, now = Date.now(),
): CodexStrictQuotaStatus {
  if (!isCodexStrictQuotaEnabled(config, quotaScope)) return { state: "off" };
  const threshold = Math.min(config.autoSwitchThreshold ?? 80, 100);
  const windows = getStrictAccountQuota(accountId)?.windows ?? [];
  if (!windows.length) return { state: "unknown", threshold };
  const hottest = windows.reduce((a, b) => a.usedPercent >= b.usedPercent ? a : b);
  const details = { threshold, usedPercent: hottest.usedPercent, resetAt: hottest.resetAt,
    updatedAt: Math.min(...windows.map(window => window.observedAt)) };
  // A deadline is a prediction. Only a new valid reading can release a measured block.
  // The switch threshold is a preference, not lost capacity. Only observed exhaustion
  // blocks admission; routing prefers below-threshold candidates when one is usable.
  if (hottest.usedPercent >= 100) return { state: "blocked", ...details };
  const fresh = windows.every(window => {
    const rawReset = window.resetAt;
    const resetMs = typeof rawReset === "number" && Number.isFinite(rawReset) && rawReset > 0
      ? (rawReset < 1_000_000_000_000 ? rawReset * 1000 : rawReset) : undefined;
    // Reaching a predicted reset requests new metadata; it never invents fresh quota.
    return now >= window.observedAt && now - window.observedAt <= CODEX_STRICT_QUOTA_FRESHNESS_MS
      && !(resetMs !== undefined && resetMs > window.observedAt && now >= resetMs);
  });
  return { state: fresh ? "ready" : "unknown", ...details };
}
export function isCodexStrictQuotaEligible(
  config: CodexStrictQuotaConfig, accountId: string, quotaScope?: QuotaScope, now = Date.now(),
): boolean {
  const { state } = getCodexStrictQuotaStatus(config, accountId, quotaScope, now);
  return state === "off" || state === "ready";
}
