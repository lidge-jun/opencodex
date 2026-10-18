/** Import-free quota policy shared by config, CLI and telemetry. */
export interface JevQuotaTiers {
  moderate?: number;
  limited?: number;
  nearlyExhausted?: number;
}
export interface ResolvedJevQuotaTiers {
  moderate?: number;
  limited: number;
  nearlyExhausted: number;
}
export const JEV_QUOTA_TIERS = ["unknown", "healthy", "moderate", "limited", "nearly_exhausted"] as const;
export type JevQuotaTier = typeof JEV_QUOTA_TIERS[number];
export const JEV_QUOTA_DEFAULT_TIERS: ResolvedJevQuotaTiers = { limited: 70, nearlyExhausted: 90 };
/** Validate quota tier overrides and merge them with the defaults; return undefined for unknown keys, non-finite or out-of-range values, or thresholds that are not strictly ascending. */
export function normalizeJevQuotaTiers(value: unknown): ResolvedJevQuotaTiers | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["moderate", "limited", "nearlyExhausted"].includes(key))) return undefined;
  if (Object.keys(raw).some(key => raw[key] === undefined)) return undefined;
  const result = { ...JEV_QUOTA_DEFAULT_TIERS, ...raw };
  const values = [result.moderate, result.limited, result.nearlyExhausted].filter(value => value !== undefined);
  if (values.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)) return undefined;
  if (Object.hasOwn(raw, "moderate") && raw.moderate === undefined) return undefined;
  if (values.some((value, i) => i > 0 && value! <= values[i - 1]!)) return undefined;
  return result as ResolvedJevQuotaTiers;
}
/** Map a used percentage to a quota tier using the thresholds; a non-finite or out-of-range percentage is unknown. */
export function jevQuotaTier(percent: number, tiers: ResolvedJevQuotaTiers = JEV_QUOTA_DEFAULT_TIERS): JevQuotaTier {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return "unknown";
  if (percent >= tiers.nearlyExhausted) return "nearly_exhausted";
  if (percent >= tiers.limited) return "limited";
  if (tiers.moderate !== undefined && percent >= tiers.moderate) return "moderate";
  return "healthy";
}
/** Rank a quota tier for ordering; unknown ties healthy so missing evidence is never treated as exhausted. */
export function jevQuotaRank(tier: JevQuotaTier): number {
  return tier === "unknown" || tier === "healthy" ? 0 : tier === "moderate" ? 1 : tier === "limited" ? 2 : 3;
}
export interface JevQuotaDecisionSummary {
  unknown: number;
  healthy: number;
  moderate: number;
  limited: number;
  nearly_exhausted: number;
  selected?: JevQuotaTier;
}
/** Validate a persisted decision quota summary (bounded per-tier counts and an optional selected tier), returning undefined when it is malformed. */
export function normalizeJevQuotaSummary(value: unknown): JevQuotaDecisionSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const result = { unknown: 0, healthy: 0, moderate: 0, limited: 0, nearly_exhausted: 0 };
  let total = 0;
  for (const tier of JEV_QUOTA_TIERS) {
    const count = raw[tier];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 64) return undefined;
    result[tier] = count; total += count;
  }
  if (total > 64) return undefined;
  const selected = JEV_QUOTA_TIERS.find(tier => tier === raw.selected);
  return { ...result, ...(selected ? { selected } : {}) };
}
