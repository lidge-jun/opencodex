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
  /**
   * Server-set: the row was observed in-band on a streaming turn, never probed.
   * Exempt from the freshness bound below, and rendered with its observation age.
   */
  observed?: boolean;
  aggregation?: unknown;
}

/**
 * How old a PROBED report may be before it stops being shown.
 *
 * A probed provider re-reads on its own TTL, so a row past this bound means the probe
 * is failing, and rendering it would present a dead number as live.
 */
export const QUOTA_REPORT_MAX_AGE_MS = 30 * 60_000;

/**
 * Narrow one wire row, dropping a probed report that has gone stale.
 *
 * Observed rows (passive providers such as `meta-muse`, whose usage arrives only inside
 * a streaming response) are exempt: their age is expected and is surfaced to the reader
 * instead of being used to delete the only measurement that exists. This lives here, in
 * the pure-derivation module, rather than inside the shell component so it can be tested
 * directly — the shell exports only its component, so a predicate defined there is
 * reachable only through a full DOM render.
 */
export function freshQuotaReport(value: unknown, now: number): ProviderQuotaReportView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.updatedAt !== "number" || !Number.isFinite(row.updatedAt)) return null;
  // A non-boolean value is treated as absent rather than rejected: the field is advisory,
  // and a strict reject would turn an unknown future value into a vanished row.
  const observed = row.observed === true;
  if (!observed && now - row.updatedAt >= QUOTA_REPORT_MAX_AGE_MS) return null;
  if (!("quota" in row)) return null;
  if (row.label !== undefined && typeof row.label !== "string") return null;
  if (row.source !== undefined && typeof row.source !== "string") return null;
  return {
    ...(typeof row.label === "string" ? { label: row.label } : {}),
    ...(typeof row.source === "string" ? { source: row.source } : {}),
    updatedAt: row.updatedAt,
    quota: row.quota,
    // Must be carried: this function rebuilds field-by-field and also re-validates the
    // session cache, so an unpropagated flag would drop the row on the next page load.
    ...(observed ? { observed: true } : {}),
    ...(row.aggregation !== undefined ? { aggregation: row.aggregation } : {}),
  };
}

/** Re-validate a cached provider→report map, dropping rows that are no longer showable. */
export function freshQuotaReportRecord(
  value: unknown,
  now = Date.now(),
): Record<string, ProviderQuotaReportView> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, ProviderQuotaReportView> = {};
  for (const [provider, raw] of Object.entries(value)) {
    const report = freshQuotaReport(raw, now);
    if (provider.trim() && report) out[provider] = report;
  }
  return out;
}

/** Narrow a `/api/provider-quotas` response body into the keyed view map. */
export function freshQuotaReportsFromResponse(
  value: unknown,
  now = Date.now(),
): Record<string, ProviderQuotaReportView> {
  if (!Array.isArray(value)) return {};
  const out: Record<string, ProviderQuotaReportView> = {};
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const provider = (raw as Record<string, unknown>).provider;
    const report = freshQuotaReport(raw, now);
    if (typeof provider === "string" && provider.trim() && report) out[provider] = report;
  }
  return out;
}

/** Observation timestamp to display beside the bars, or undefined for a probed row. */
export function observedAtFromReport(report?: ProviderQuotaReportView): number | undefined {
  return report?.observed === true && typeof report.updatedAt === "number" ? report.updatedAt : undefined;
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
