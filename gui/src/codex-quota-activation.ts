import { quotaAutoRefreshAvailability } from "./codex-quota-utils";
import type { CodexAccountEntry } from "./hooks/useCodexAccountPool";

export type QuotaAutoRefreshSettings = Record<string, { fiveHour?: boolean; weekly?: boolean }>;

export function readQuotaActivationSettings(payload: unknown): QuotaAutoRefreshSettings {
  const settings = payload && typeof payload === "object" && "codexQuotaAutoRefresh" in payload
    ? payload.codexQuotaAutoRefresh : null;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)
    || Object.values(settings).some(value => !value || typeof value !== "object" || Array.isArray(value)
      || [value.fiveHour, value.weekly].some(flag => flag !== undefined && typeof flag !== "boolean"))) {
    throw new Error("Invalid quota activation settings");
  }
  return settings as QuotaAutoRefreshSettings;
}

export function quotaActivationWindows(accounts: CodexAccountEntry[], settings: QuotaAutoRefreshSettings) {
  return accounts.flatMap(account => {
    const id = account.isMain ? "__main__" : account.id;
    const available = account.quotaAutoRefresh ?? quotaAutoRefreshAvailability(account.quota);
    return (["fiveHour", "weekly"] as const).map(window => ({
      id, window,
      available: available[window === "fiveHour" ? "fiveHourAvailable" : "weeklyAvailable"],
      enabled: settings[id]?.[window] === true,
    }));
  });
}
