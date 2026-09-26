/** Kiro login identity and persisted evidence entrypoints. */
import { createHash } from "node:crypto";
import type { ProviderAccount } from "../oauth/types";
import type { ProviderQuota } from "./quota-types";
import { hydrateAccountQuotaCache, persistAccountQuotaCache } from "./quota/account-cache";

export function kiroEvidenceIdentity(account: ProviderAccount): string {
  const cred = account.credential;
  return createHash("sha256").update(JSON.stringify([
    account.id, account.loginId ?? String(account.addedAt ?? ""),
    cred.accountId ?? cred.email ?? "", cred.kiro?.profileArn ?? "",
    cred.kiro?.clientId ?? "",
  ])).digest("hex");
}

export interface KiroPersistedQuota extends ProviderQuota { identity: string; }

/** Keep only the closed set emitted by the Kiro parser when disk data is rewritten. */
export function sanitizeKiroQuota(quota: ProviderQuota): ProviderQuota {
  const trial = quota.customWindows?.find(window => window.label === "Free trial"
    && typeof window.percent === "number" && Number.isFinite(window.percent)
    && window.percent >= 0 && window.percent <= 100);
  return {
    monthlyPercent: quota.monthlyPercent,
    ...(typeof quota.monthlyResetAt === "number" && Number.isFinite(quota.monthlyResetAt)
      && Number.isFinite(new Date(quota.monthlyResetAt).getTime())
      ? { monthlyResetAt: quota.monthlyResetAt } : {}),
    ...(trial ? { customWindows: [{ label: "Free trial", percent: trial.percent }] } : {}),
    updatedAt: quota.updatedAt,
  };
}
export interface KiroPersistedVerdict {
  exhausted: boolean;
  resetAt?: number;
  observedAt: number;
  identity: string;
}

export function hydrateKiroAccountState(): void { hydrateAccountQuotaCache(); }
export function persistKiroAccountState(): void { persistAccountQuotaCache(); }
