// Shared labels and formatting for where a model's price came from.
import { LOCALES, getActiveLocale, type TFn, type TKey } from "../i18n/shared";
import type { ModelRowPrice } from "../pages/models-shared";
import { MAX_RATE, RATE_FIELDS, type ModelCost } from "./model-price-cost";

export type PriceSourceId = ModelRowPrice["source"] | "unknown";

export const PRICE_SOURCE_LABEL: Record<PriceSourceId, TKey> = {
  manual: "pricing.override.badge",
  official: "pricing.source.official",
  "models-dev": "pricing.source.models-dev",
  openrouter: "pricing.source.openrouter",
  unknown: "pricing.source.unknown",
};

// Format in the dashboard's language, not the browser's: the two differ when a user picks one.
const intlLocale = () => LOCALES.find(entry => entry.code === getActiveLocale())?.htmlLang;
export const formatRate = (value: number): string => value.toLocaleString(intlLocale(), { maximumFractionDigits: 6 });

export function ratesLine(t: TFn, price: ModelRowPrice): string {
  return t("pricing.source.rates", {
    input: formatRate(price.input), output: formatRate(price.output),
    cacheRead: formatRate(price.cacheRead), cacheWrite: formatRate(price.cacheWrite),
  });
}

/** Tooltip lines: source, rates, fetched time, relay multiplier, API-equivalent flag. */
export function describePrice(t: TFn, price: ModelRowPrice): string[] {
  const lines = [t(PRICE_SOURCE_LABEL[price.source]), ratesLine(t, price)];
  const fetched = price.fetchedAt ? new Date(price.fetchedAt) : null;
  if (fetched && !Number.isNaN(fetched.getTime())) lines.push(t("pricing.source.fetched", { time: fetched.toLocaleString(intlLocale()) }));
  if (price.multiplier !== undefined) lines.push(t("pricing.source.multiplier", { multiplier: formatRate(price.multiplier) }));
  if (price.apiEquivalent) lines.push(t("pricing.source.apiEquivalent"));
  return lines;
}

/** The automatic rates as a savable manual price; null when the price is already manual or not savable. */
export function adoptableCost(price: ModelRowPrice | undefined): ModelCost | null {
  if (!price || price.source === "manual") return null;
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  const cost = { input: round(price.input), output: round(price.output), cacheRead: round(price.cacheRead), cacheWrite: round(price.cacheWrite) };
  return RATE_FIELDS.every(field => Number.isFinite(cost[field]) && cost[field] >= 0 && cost[field] <= MAX_RATE) ? cost : null;
}
