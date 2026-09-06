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
  const threshold = Math.min(config.autoSwitchThreshold ?? 80, 99);
  const windows = getStrictAccountQuota(accountId)?.windows ?? [];
  if (!windows.length) return { state: "unknown", threshold };
  const hottest = windows.reduce((a, b) => a.usedPercent >= b.usedPercent ? a : b);
  const details = { threshold, usedPercent: hottest.usedPercent, resetAt: hottest.resetAt,
    updatedAt: Math.min(...windows.map(window => window.observedAt)) };
  // A deadline is a prediction. Only a new valid reading can release a measured block.
  if (hottest.usedPercent >= threshold) return { state: "blocked", ...details };
  const fresh = windows.every(window => now >= window.observedAt
    && now - window.observedAt <= CODEX_STRICT_QUOTA_FRESHNESS_MS);
  return { state: fresh ? "ready" : "unknown", ...details };
}
export function isCodexStrictQuotaEligible(
  config: CodexStrictQuotaConfig, accountId: string, quotaScope?: QuotaScope, now = Date.now(),
): boolean {
  const { state } = getCodexStrictQuotaStatus(config, accountId, quotaScope, now);
  return state === "off" || state === "ready";
}
