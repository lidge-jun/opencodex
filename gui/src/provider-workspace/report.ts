/**
 * provider-workspace/report.ts — pure derivations for the workspace detail
 * panels (WP090): quota-report → AccountQuota adaptation, quota source labels,
 * and the models-tab filter. No React, no fetch.
 */
import type { AccountQuota } from "../codex-quota-utils";

/** Wire shape of one /api/provider-quotas report row as the workspace consumes it. */
export interface ProviderQuotaReportView {
  label?: string;
  source?: string;
  updatedAt?: number;
  quota?: unknown;
}

/** Narrow an unknown quota payload into the AccountQuota display shape (null when unusable). */
export function accountQuotaFromReport(report?: ProviderQuotaReportView): AccountQuota | null {
  const quota = report?.quota;
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) return null;
  const q = quota as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const windows = Array.isArray(q.customWindows)
    ? (q.customWindows as unknown[]).flatMap(w => {
        if (!w || typeof w !== "object") return [];
        const row = w as Record<string, unknown>;
        if (typeof row.label !== "string" || num(row.percent) === undefined) return [];
        return [{
          label: row.label,
          percent: row.percent as number,
          ...(num(row.resetAt) !== undefined ? { resetAt: row.resetAt as number } : {}),
        }];
      })
    : [];
  const out: AccountQuota = {
    ...(num(q.fiveHourPercent) !== undefined ? { fiveHourPercent: q.fiveHourPercent as number } : {}),
    ...(num(q.fiveHourResetAt) !== undefined ? { fiveHourResetAt: q.fiveHourResetAt as number } : {}),
    ...(num(q.weeklyPercent) !== undefined ? { weeklyPercent: q.weeklyPercent as number } : {}),
    ...(num(q.weeklyResetAt) !== undefined ? { weeklyResetAt: q.weeklyResetAt as number } : {}),
    ...(num(q.monthlyPercent) !== undefined ? { monthlyPercent: q.monthlyPercent as number } : {}),
    ...(num(q.monthlyResetAt) !== undefined ? { monthlyResetAt: q.monthlyResetAt as number } : {}),
    ...(windows.length > 0 ? { customWindows: windows } : {}),
    updatedAt: num(q.updatedAt) ?? report?.updatedAt ?? Date.now(),
  };
  const hasSignal = out.fiveHourPercent !== undefined
    || out.weeklyPercent !== undefined
    || out.monthlyPercent !== undefined
    || (out.customWindows?.length ?? 0) > 0;
  return hasSignal ? out : null;
}

/** Human label for a quota report source id (e.g. "cursor:period-usage"). */
export function formatQuotaSourceLabel(source: string | undefined): string {
  if (!source?.trim()) return "";
  const [provider, path] = source.split(":", 2);
  if (!path) return source;
  return `${provider} · ${path.replace(/-/g, " ")}`;
}

/**
 * Models-tab list derivation: live models, else configured static ids, else
 * the default model as a single-row fallback; filtered by substring query.
 */
export function filterModels(
  base: string[],
  defaultModel: string | undefined,
  query: string,
  configuredModels?: string[],
): string[] {
  const list = base.length > 0
    ? base
    : (configuredModels && configuredModels.length > 0)
      ? configuredModels
      : defaultModel ? [defaultModel] : [];
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(id => id.toLowerCase().includes(q));
}
