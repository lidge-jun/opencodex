import { resolveMatchedPrice } from "../../usage/cost";

/** Effective price shown on an `/api/models` row; absent on the row means the price is unknown. */
export interface ModelRowPrice {
  source: "manual" | "official" | "models-dev" | "openrouter";
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** ISO time of the catalog fetch that produced a models-dev / openrouter price. */
  fetchedAt?: string;
  multiplier?: number;
  apiEquivalent?: true;
}

/** Effective (post-multiplier) rates and where they came from, via the same resolver the cost estimate uses. */
export function modelRowPrice(provider: string, modelId: string): ModelRowPrice | undefined {
  const price = resolveMatchedPrice(provider, modelId);
  if (!price) return undefined;
  const online = price.source === "models-dev" || price.source === "openrouter";
  const source: ModelRowPrice["source"] = price.source === "user" ? "manual"
    : price.source === "models-dev" || price.source === "openrouter" ? price.source : "official";
  return {
    source,
    ...price.cost4,
    ...(online && price.verifiedAt ? { fetchedAt: price.verifiedAt } : {}),
    ...(price.multiplier !== undefined ? { multiplier: price.multiplier } : {}),
    ...(price.apiEquivalent ? { apiEquivalent: true as const } : {}),
  };
}
