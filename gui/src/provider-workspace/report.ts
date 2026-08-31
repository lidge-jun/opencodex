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
  aggregation?: unknown;
}

export interface CapacityWindowView {
  usedPercent: number;
  incomplete?: boolean;
  excludedAccounts?: number;
  nextRecoveryAt?: number;
  nextRecoveryPercent?: number;
}

export interface ProviderCapacityAggregationView {
  presentation: "aggregate" | "effective-account-fallback" | "coverage-only";
  incomplete: boolean;
  excludedAccounts: number;
  unknownPlanAccounts: number;
  partialWindowAccounts: number;
  fiveHour?: CapacityWindowView;
  weekly?: CapacityWindowView;
  monthly?: CapacityWindowView;
  customWindows?: Array<CapacityWindowView & { label: string }>;
  currentAccount?: { plan?: string | null; quota: AccountQuota | null };
}

const finite = (value: unknown): number | undefined => (
  typeof value === "number" && Number.isFinite(value) ? value : undefined
);

/**
 * A finite number is not necessarily a representable date.
 *
 * Reports are also read from persisted cache, so a bogus expiry recorded before the wire-side
 * guard existed still reaches the GUI. `Intl.DateTimeFormat.format()` throws a RangeError on an
 * out-of-range time value rather than rendering it, which turns one bad provider field into a
 * render fault for the whole capacity panel. Drop the field instead: the rest of the credit
 * figures stay useful without it.
 */
const dateTimestamp = (value: unknown): number | undefined => {
  const timestamp = finite(value);
  if (timestamp === undefined) return undefined;
  const milliseconds = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  return Number.isFinite(new Date(milliseconds).getTime()) ? timestamp : undefined;
};

function quotaFromUnknown(quota: unknown, fallbackUpdatedAt?: number): AccountQuota | null {
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) return null;
  const q = quota as Record<string, unknown>;
  const windows = Array.isArray(q.customWindows)
    ? (q.customWindows as unknown[]).flatMap(w => {
        if (!w || typeof w !== "object") return [];
        const row = w as Record<string, unknown>;
        if (typeof row.label !== "string" || finite(row.percent) === undefined) return [];
        return [{
          label: row.label,
          percent: row.percent as number,
          ...(finite(row.resetAt) !== undefined ? { resetAt: row.resetAt as number } : {}),
        }];
      })
    : [];
  const creditsRaw = q.creditsUsd && typeof q.creditsUsd === "object" && !Array.isArray(q.creditsUsd)
    ? q.creditsUsd as Record<string, unknown>
    : null;
  const creditsUsed = finite(creditsRaw?.used);
  const creditsLimit = finite(creditsRaw?.limit);
  const creditsRemaining = finite(creditsRaw?.remaining);
  const creditsPercent = finite(creditsRaw?.percent);
  const creditsExpiresAt = dateTimestamp(creditsRaw?.expiresAt);
  const creditsUsd = creditsUsed !== undefined
    && creditsLimit !== undefined
    && creditsRemaining !== undefined
    && creditsPercent !== undefined
    ? {
        used: creditsUsed,
        limit: creditsLimit,
        remaining: creditsRemaining,
        percent: creditsPercent,
        ...(creditsExpiresAt !== undefined ? { expiresAt: creditsExpiresAt } : {}),
        ...(typeof creditsRaw?.unlimited === "boolean" ? { unlimited: creditsRaw.unlimited } : {}),
      }
    : undefined;
  const out: AccountQuota = {
    ...(finite(q.fiveHourPercent) !== undefined ? { fiveHourPercent: q.fiveHourPercent as number } : {}),
    ...(finite(q.fiveHourResetAt) !== undefined ? { fiveHourResetAt: q.fiveHourResetAt as number } : {}),
    ...(finite(q.weeklyPercent) !== undefined ? { weeklyPercent: q.weeklyPercent as number } : {}),
    ...(finite(q.weeklyResetAt) !== undefined ? { weeklyResetAt: q.weeklyResetAt as number } : {}),
    ...(finite(q.monthlyPercent) !== undefined ? { monthlyPercent: q.monthlyPercent as number } : {}),
    ...(finite(q.monthlyResetAt) !== undefined ? { monthlyResetAt: q.monthlyResetAt as number } : {}),
    ...(windows.length > 0 ? { customWindows: windows } : {}),
    ...(creditsUsd ? { creditsUsd } : {}),
    updatedAt: finite(q.updatedAt) ?? fallbackUpdatedAt ?? Date.now(),
  };
  return out.fiveHourPercent !== undefined
    || out.weeklyPercent !== undefined
    || out.monthlyPercent !== undefined
    || (out.customWindows?.length ?? 0) > 0
    || out.creditsUsd !== undefined
    ? out
    : null;
}

/** Narrow an unknown quota payload into the AccountQuota display shape (null when unusable). */
export function accountQuotaFromReport(report?: ProviderQuotaReportView): AccountQuota | null {
  return quotaFromUnknown(report?.quota, report?.updatedAt);
}

function capacityWindow(value: unknown): CapacityWindowView | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const usedPercent = finite(row.usedPercent);
  if (usedPercent === undefined) return undefined;
  return {
    usedPercent,
    ...(typeof row.incomplete === "boolean" ? { incomplete: row.incomplete } : {}),
    ...(finite(row.excludedAccounts) !== undefined ? { excludedAccounts: row.excludedAccounts as number } : {}),
    ...(finite(row.nextRecoveryAt) !== undefined ? { nextRecoveryAt: row.nextRecoveryAt as number } : {}),
    ...(finite(row.nextRecoveryPercent) !== undefined ? { nextRecoveryPercent: row.nextRecoveryPercent as number } : {}),
  };
}

/** Strictly narrows optional weighted-pool metadata; legacy reports return null. */
export function capacityAggregationFromReport(report?: ProviderQuotaReportView): ProviderCapacityAggregationView | null {
  const value = report?.aggregation;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.kind !== "capacity-weighted-v1" || row.scope !== "routable-known") return null;
  const excludedAccounts = finite(row.excludedAccounts);
  const unknownPlanAccounts = finite(row.unknownPlanAccounts);
  if (excludedAccounts === undefined || unknownPlanAccounts === undefined || typeof row.incomplete !== "boolean") return null;
  const currentRaw = row.currentAccount && typeof row.currentAccount === "object" && !Array.isArray(row.currentAccount)
    ? row.currentAccount as Record<string, unknown>
    : null;
  const customWindows = Array.isArray(row.customWindows)
    ? row.customWindows.flatMap(entry => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const custom = entry as Record<string, unknown>;
        const window = capacityWindow(custom);
        return typeof custom.label === "string" && window ? [{ label: custom.label, ...window }] : [];
      })
    : [];
  const fiveHour = capacityWindow(row.fiveHour);
  const weekly = capacityWindow(row.weekly);
  const monthly = capacityWindow(row.monthly);
  const hasAggregateWindow = !!fiveHour || !!weekly || !!monthly || customWindows.length > 0;
  const presentation = row.presentation === "aggregate"
    || row.presentation === "effective-account-fallback"
    || row.presentation === "coverage-only"
    ? row.presentation
    : hasAggregateWindow ? "aggregate" : "coverage-only";
  return {
    presentation,
    incomplete: row.incomplete,
    excludedAccounts,
    unknownPlanAccounts,
    partialWindowAccounts: finite(row.partialWindowAccounts) ?? 0,
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
    ...(monthly ? { monthly } : {}),
    ...(customWindows.length > 0 ? { customWindows } : {}),
    ...(currentRaw ? {
      currentAccount: {
        ...(typeof currentRaw.plan === "string" || currentRaw.plan === null ? { plan: currentRaw.plan } : {}),
        quota: quotaFromUnknown(currentRaw.quota),
      },
    } : {}),
  };
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
  configuredModels: string[] | undefined,
  customModels: string[],
  /**
   * Whether the last successful discovery returned any rows, taken from the server. Required:
   * inferring it by subtracting custom ids from `base` misreads a live catalog as custom-only
   * whenever a custom id also appears upstream, which wrongly keeps the configured fallback
   * authoritative.
   */
  hasLiveModels: boolean,
): string[] {
  const fallback = configuredModels && configuredModels.length > 0
    ? configuredModels
    : defaultModel ? [defaultModel] : [];
  const primary = hasLiveModels ? base : fallback;
  const list = [...new Set([...primary, ...customModels])];
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(id => id.toLowerCase().includes(q));
}
