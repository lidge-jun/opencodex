/**
 * Response service tiers a request-log row may record. A provider can return any string in
 * `service_tier` (or an Anthropic `speed`), so only these closed members are kept; anything else
 * is omitted. Pricing and Fast confirmation read the raw observation separately.
 */
export const RESPONSE_SERVICE_TIERS = ["auto", "default", "flex", "scale", "priority", "fast", "standard", "ultrafast"] as const;

export type ResponseServiceTier = typeof RESPONSE_SERVICE_TIERS[number];

const TIERS: ReadonlySet<string> = new Set(RESPONSE_SERVICE_TIERS);

/** The closed member a tier names (case-insensitive), or undefined. */
export function boundedServiceTier(value: unknown): ResponseServiceTier | undefined {
  if (typeof value !== "string") return undefined;
  const folded = value.trim().toLowerCase();
  return TIERS.has(folded) ? folded as ResponseServiceTier : undefined;
}
