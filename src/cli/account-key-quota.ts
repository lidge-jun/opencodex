/** Public API-key quota projection; private probe identity stays on the server. */
import { parseQuotaFailureCode, type AccountQuotaFields, type ProviderQuota, type ProviderQuotaWindow, type ProviderQuotaCreditsUsd } from "../providers/quota-types";
import { terminalSafeText } from "./runtime-api";
import type { AccountRow, FamilyRows } from "./account-api";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed API-key quota response.");
  return value as Record<string, unknown>;
}
function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Malformed API-key quota response.");
  return value;
}
function optionalString(row: Record<string, unknown>, key: string): string | undefined {
  if (row[key] === undefined) return undefined;
  if (typeof row[key] !== "string") throw new Error("Malformed API-key quota response.");
  return row[key];
}
function optionalBoolean(row: Record<string, unknown>, key: string): boolean | undefined {
  if (row[key] === undefined) return undefined;
  if (typeof row[key] !== "boolean") throw new Error("Malformed API-key quota response.");
  return row[key];
}
function windowProjection(value: unknown): ProviderQuotaWindow {
  const row = record(value);
  const label = optionalString(row, "label");
  if (label === undefined) throw new Error("Malformed API-key quota response.");
  const result: ProviderQuotaWindow = { label, percent: finite(row.percent) };
  if (row.resetAt !== undefined) result.resetAt = finite(row.resetAt);
  if (row.passiveObservedAt !== undefined) result.passiveObservedAt = finite(row.passiveObservedAt);
  if (row.scope !== undefined) {
    if (row.scope !== "model") throw new Error("Malformed API-key quota response.");
    result.scope = row.scope;
  }
  if (row.rejected !== undefined) {
    if (row.rejected !== true) throw new Error("Malformed API-key quota response.");
    result.rejected = true;
  }
  return result;
}
function creditsProjection(value: unknown): ProviderQuotaCreditsUsd {
  const row = record(value);
  const result: ProviderQuotaCreditsUsd = {
    used: finite(row.used), limit: finite(row.limit), remaining: finite(row.remaining), percent: finite(row.percent),
  };
  if (row.expiresAt !== undefined) result.expiresAt = finite(row.expiresAt);
  const unlimited = optionalBoolean(row, "unlimited");
  if (unlimited !== undefined) result.unlimited = unlimited;
  return result;
}
function quotaProjection(value: unknown): ProviderQuota | null {
  if (value === null) return null;
  const row = record(value);
  const result: ProviderQuota = { updatedAt: finite(row.updatedAt) };
  for (const key of ["fiveHourPercent", "fiveHourResetAt", "weeklyPercent", "weeklyResetAt", "monthlyPercent", "monthlyResetAt", "kiroCreditsUsed", "kiroCreditsLimit"] as const) {
    if (row[key] !== undefined) result[key] = finite(row[key]);
  }
  if (row.customWindows !== undefined) {
    if (!Array.isArray(row.customWindows)) throw new Error("Malformed API-key quota response.");
    result.customWindows = row.customWindows.map(windowProjection);
  }
  if (row.creditsUsd !== undefined) result.creditsUsd = creditsProjection(row.creditsUsd);
  return result;
}

/** Only opt-in reads use the strict DTO boundary; legacy cheap lists retain their contract. */
export function projectApiKeyQuotaRows(value: unknown, provider: string): FamilyRows {
  const body = record(value);
  if (!Array.isArray(body.keys) || (body.activeId !== null && typeof body.activeId !== "string")) {
    throw new Error("Malformed API-key quota response.");
  }
  const activeId = body.activeId;
  const rows: AccountRow[] = body.keys.map(value => {
    const row = record(value);
    const id = optionalString(row, "id");
    if (!id) throw new Error("Malformed API-key quota response.");
    const quotaMode = row.quotaMode;
    if (quotaMode === undefined) throw new Error("API-key quota is unverified: server did not report quotaMode. Update the proxy and retry.");
    if (quotaMode !== "probe" && quotaMode !== "passive" && quotaMode !== "unsupported") throw new Error("Malformed API-key quota response.");
    const fields: AccountQuotaFields = { quotaMode };
    if (row.quota !== undefined) fields.quota = quotaProjection(row.quota);
    const unavailable = optionalBoolean(row, "quotaUnavailable");
    if (unavailable !== undefined) fields.quotaUnavailable = unavailable;
    if (row.quotaFailure !== undefined) {
      const failure = parseQuotaFailureCode(row.quotaFailure);
      if (!failure) throw new Error("Malformed API-key quota response.");
      if (unavailable === true) fields.quotaFailure = failure;
    }
    const masked = optionalString(row, "masked");
    return { provider, type: "api-key", id, label: optionalString(row, "label") ?? masked,
      masked, active: optionalBoolean(row, "active") ?? id === activeId, ...fields };
  });
  return { rows, activeId, status: 200 };
}

export function apiKeyQuotaText(row: AccountRow): string {
  const mode = row.quotaMode;
  if (!mode) return "unverified";
  if (mode === "unsupported") return "unsupported";
  if (row.quotaUnavailable) return `${mode}: unavailable${row.quotaFailure ? ` (${row.quotaFailure})` : ""}`;
  const quota = row.quota;
  if (!quota) return `${mode}: not measured`;
  const parts: string[] = [];
  for (const [label, percent] of [["5h", quota.fiveHourPercent], ["wk", quota.weeklyPercent], ["mo", quota.monthlyPercent]] as const) {
    if (percent !== undefined) parts.push(`${label} ${percent}%`);
  }
  for (const window of quota.customWindows ?? []) {
    // Labels are upstream text: keep terminal controls out of the human table.
    const label = terminalSafeText(window.label);
    parts.push(`${label} ${window.percent}%${window.rejected ? " (rejected)" : ""}`);
  }
  if (quota.creditsUsd) {
    const c = quota.creditsUsd;
    parts.push(`USD ${c.used}/${c.unlimited ? "unlimited" : c.limit} used; ${c.remaining} remaining (${c.percent}%)`);
  }
  if (quota.kiroCreditsUsed !== undefined || quota.kiroCreditsLimit !== undefined) parts.push(`credits ${quota.kiroCreditsUsed ?? "?"}/${quota.kiroCreditsLimit ?? "?"}`);
  return `${mode}: ${parts.join("; ") || "not measured"}`;
}
