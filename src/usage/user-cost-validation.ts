/** Pure model-cost validation shared by config, migration, and display lifting. */
import type { ProviderCostOverlay, PromptLengthPricing } from "../types";
import { MAX_COST4_RATE } from "./expected-prices";

/** Exact four fields accepted for a user-configured cost tuple. */
export const COST4_RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** Shared per-rate predicate used by config validation, display sanitization, and runtime lifting. */
export function isValidCost4Rate(rate: unknown): rate is number {
  return typeof rate === "number"
    && Number.isFinite(rate)
    && rate >= 0
    && rate <= MAX_COST4_RATE;
}

/** Complete base rates with a valid optional policy; extra top-level fields are never copied. */
export function validCost4(value: unknown): value is ProviderCostOverlay {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return COST4_RATE_KEYS.every(key => Object.hasOwn(entry, key) && isValidCost4Rate(entry[key]))
    && (!Object.hasOwn(entry, "promptLengthPricing") || isValidPromptLengthPricing(entry.promptLengthPricing));
}

/** Strict nested policy boundary; diagnostics never echo untrusted policy fields. */
export function isValidPromptLengthPricing(value: unknown): value is PromptLengthPricing {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  if (!Object.hasOwn(policy, "mode")) return false;
  if (policy.mode === "automatic" || policy.mode === "flat") return Object.keys(policy).length === 1;
  if (policy.mode !== "custom" || Object.keys(policy).length !== 4
    || !["mode", "thresholdTokens", "comparison", "rates"].every(key => Object.hasOwn(policy, key))
    || typeof policy.thresholdTokens !== "number" || !Number.isSafeInteger(policy.thresholdTokens)
    || policy.thresholdTokens <= 0 || (policy.comparison !== "gt" && policy.comparison !== "gte")) return false;
  const rates = policy.rates;
  return !!rates && typeof rates === "object" && !Array.isArray(rates)
    && Object.keys(rates).length === COST4_RATE_KEYS.length
    && COST4_RATE_KEYS.every(key => Object.hasOwn(rates, key) && isValidCost4Rate((rates as Record<string, unknown>)[key]));
}
