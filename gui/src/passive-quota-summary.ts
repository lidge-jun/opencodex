import type { TKey } from "./i18n/en";

export interface PassiveQuotaWindow {
  dimension: "requests" | "tokens" | "input-tokens" | "output-tokens";
  window?: "minute" | "day" | "month";
  observedAt: number;
  remaining?: number;
  limit?: number;
  resetAt?: number;
  stale: boolean;
}

export interface PassiveQuotaRow {
  provider: string;
  keyId: string;
  account: number;
  model: string;
  windows: PassiveQuotaWindow[];
}

export const passiveDimensionKeys: Record<PassiveQuotaWindow["dimension"], TKey> = {
  requests: "usage.col.requests", tokens: "usage.col.tokens",
  "input-tokens": "usage.col.inputTokens", "output-tokens": "usage.col.outputTokens",
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 253_402_300_799_999;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000_000_000;

/** Accept only the published display fields; never carry arbitrary response fields into the UI. */
export function parsePassiveQuotaRows(value: unknown): PassiveQuotaRow[] {
  if (!Array.isArray(value)) return [];
  const rows: PassiveQuotaRow[] = [];
  const accounts = new Map<string, Map<string, number>>();
  const seen = new Set<string>();
  for (const item of value) {
    if (!record(item) || typeof item.provider !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.provider)
      || typeof item.keyId !== "string" || !item.keyId || item.keyId.length > 256
      || typeof item.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(item.model) || !Array.isArray(item.windows)) continue;
    const windows: PassiveQuotaWindow[] = [];
    const kinds = new Set<string>();
    for (const raw of item.windows) {
      if (!record(raw) || typeof raw.dimension !== "string" || !Object.hasOwn(passiveDimensionKeys, raw.dimension)
        || (raw.window !== undefined && raw.window !== "minute" && raw.window !== "day" && raw.window !== "month")
        || !timestamp(raw.observedAt) || typeof raw.stale !== "boolean") continue;
      const kind = `${raw.dimension}:${raw.window ?? ""}`;
      if (kinds.has(kind)) continue;
      kinds.add(kind);
      windows.push({ dimension: raw.dimension as PassiveQuotaWindow["dimension"],
        ...(raw.window ? { window: raw.window } : {}), observedAt: raw.observedAt, stale: raw.stale,
        ...(count(raw.remaining) ? { remaining: raw.remaining } : {}),
        ...(count(raw.limit) ? { limit: raw.limit } : {}),
        ...(timestamp(raw.resetAt) ? { resetAt: raw.resetAt } : {}) });
    }
    if (!windows.length) continue;
    const identity = JSON.stringify([item.provider, item.keyId, item.model]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    let providerAccounts = accounts.get(item.provider);
    if (!providerAccounts) { providerAccounts = new Map(); accounts.set(item.provider, providerAccounts); }
    if (!providerAccounts.has(item.keyId)) providerAccounts.set(item.keyId, providerAccounts.size + 1);
    rows.push({ provider: item.provider, keyId: item.keyId, account: providerAccounts.get(item.keyId)!, model: item.model, windows });
  }
  return rows;
}
