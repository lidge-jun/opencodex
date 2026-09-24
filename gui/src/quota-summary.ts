/**
 * quota-summary.ts — pure derivation for the header quota summary bar.
 *
 * Reads only what `/api/provider-quotas` already reports (each provider's own quota
 * endpoint, cached server-side). No usage estimation happens here: a provider without a
 * reported window simply has no row.
 */
import type { AccountQuota } from "./codex-quota-utils";
import type { TKey } from "./i18n/en";
import { quotaWindows, resetTimestamp } from "./pages/tray-data";
import { accountQuotaFromReport, type ProviderQuotaReportView } from "./provider-workspace/report";

export const QUOTA_SUMMARY_WARN_PERCENT = 70;
export const QUOTA_SUMMARY_CRITICAL_PERCENT = 90;

export type QuotaSummarySeverity = "normal" | "warn" | "critical";

export interface QuotaSummaryWindow {
  id: string;
  /** Fixed window label (5h / weekly / monthly / credits). */
  labelKey?: TKey;
  /** Provider-named window label, shown verbatim. */
  label?: string;
  percent?: number;
  resetAt?: number;
  severity: QuotaSummarySeverity;
}

export interface QuotaSummaryRow {
  provider: string;
  label: string;
  headline: QuotaSummaryWindow;
  windows: QuotaSummaryWindow[];
  updatedAt?: number;
  observed: boolean;
  severity: QuotaSummarySeverity;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function quotaSeverity(percent: number | undefined): QuotaSummarySeverity {
  if (!finite(percent)) return "normal";
  if (percent >= QUOTA_SUMMARY_CRITICAL_PERCENT) return "critical";
  if (percent >= QUOTA_SUMMARY_WARN_PERCENT) return "warn";
  return "normal";
}

// Flooring keeps the displayed number on the same side of the 70/90 thresholds as the color.
export function formatQuotaPercent(percent: number | undefined): string {
  return finite(percent) ? `${Math.floor(percent)}%` : "-";
}

/** Long windows first: weekly is the default headline, then monthly, then 5h, then custom. */
const HEADLINE_ORDER = ["quota.weeklyLimit", "quota.monthlyLimit", "quota.fiveHourLimit"];

function summaryWindows(quota: AccountQuota): QuotaSummaryWindow[] {
  const windows: QuotaSummaryWindow[] = quotaWindows(quota).map(window => {
    const percent = finite(window.percent) ? window.percent : undefined;
    const resetMs = resetTimestamp(window.reset);
    return {
      id: window.id,
      ...("key" in window && window.key ? { labelKey: window.key } : {}),
      ...("label" in window && typeof window.label === "string" ? { label: window.label } : {}),
      ...(percent !== undefined ? { percent } : {}),
      ...(resetMs !== null ? { resetAt: resetMs } : {}),
      severity: quotaSeverity(percent),
    };
  });
  const credits = quota.creditsUsd;
  if (credits && credits.unlimited !== true && finite(credits.percent)) {
    const expiresMs = resetTimestamp(credits.expiresAt);
    windows.push({
      id: "quotaSummary.credits",
      labelKey: "quotaSummary.credits",
      percent: credits.percent,
      ...(expiresMs !== null ? { resetAt: expiresMs } : {}),
      severity: quotaSeverity(credits.percent),
    });
  }
  return windows;
}

function pickHeadline(windows: QuotaSummaryWindow[]): QuotaSummaryWindow | undefined {
  const measured = windows.filter(window => window.percent !== undefined);
  const byId = new Map(measured.map(window => [window.id, window]));
  for (const id of HEADLINE_ORDER) {
    const hit = byId.get(id);
    if (hit) return hit;
  }
  return measured[0];
}

/**
 * Build one summary row per provider that reported at least one measured window.
 * `reports` is the map produced by `freshQuotaReportsFromResponse`, so stale probes are
 * already dropped and response order is preserved.
 */
export function buildQuotaSummary(
  reports: Record<string, ProviderQuotaReportView>,
  displayName: (provider: string) => string,
): QuotaSummaryRow[] {
  const rows: QuotaSummaryRow[] = [];
  for (const [provider, report] of Object.entries(reports)) {
    const quota = accountQuotaFromReport(report);
    if (!quota) continue;
    const windows = summaryWindows(quota);
    const headline = pickHeadline(windows);
    if (!headline) continue;
    rows.push({
      provider,
      label: report.label?.trim() || displayName(provider),
      headline,
      windows,
      ...(finite(report.updatedAt) ? { updatedAt: report.updatedAt } : {}),
      observed: report.observed === true,
      severity: headline.severity,
    });
  }
  return rows;
}
