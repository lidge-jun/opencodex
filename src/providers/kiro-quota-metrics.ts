/** Cache-only Kiro quota projection for the opt-in metrics snapshot. */
import { oauthAccountLogLabel } from "../codex/account-label";
import { getAccountSet } from "../oauth/store";
import { kiroAccountEvidence } from "./kiro-usage";

export interface KiroQuotaMetricRow {
  account: string;
  used: number;
  limit: number;
  percent: number;
  secondsToReset?: number;
}

const MAX_KIRO_METRIC_ACCOUNTS = 32;

export function cachedKiroQuotaMetricRows(now = Date.now()): KiroQuotaMetricRow[] {
  const accounts = getAccountSet("kiro")?.accounts ?? [];
  const rows: KiroQuotaMetricRow[] = [];
  const labels = new Set<string>();
  for (const account of [...accounts].sort((a, b) => a.id.localeCompare(b.id))) {
    const { quotaPercent: percent, creditsUsed: used, creditsLimit: limit, resetAt } =
      kiroAccountEvidence(account, now, { hydrate: false });
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0
      || typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0
      || typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100
      || (resetAt !== undefined && (!Number.isFinite(resetAt) || resetAt <= now))) continue;
    const label = oauthAccountLogLabel(account.id, "kiro");
    if (labels.has(label)) continue;
    labels.add(label);
    rows.push({ account: label, used, limit, percent,
      ...(resetAt !== undefined ? { secondsToReset: (resetAt - now) / 1000 } : {}) });
    if (rows.length === MAX_KIRO_METRIC_ACCOUNTS) break;
  }
  return rows;
}
