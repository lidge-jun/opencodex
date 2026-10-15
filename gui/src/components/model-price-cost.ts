// Contract helpers for model-cost rows and prompt-length pricing.
export const RATE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export type RateField = (typeof RATE_FIELDS)[number];
export type Rates = Record<RateField, number>;
export type RateDraft = Record<RateField, string>;
export type Comparison = "gt" | "gte";
export type PromptLengthPricing =
  | { mode: "flat" }
  | { mode: "custom"; thresholdTokens: number; comparison: Comparison; rates: Rates };
export type ModelCost = Rates & { promptLengthPricing?: PromptLengthPricing };
export type PricingMode = "automatic" | "flat" | "custom";
export interface CustomDraft extends RateDraft { threshold: string; comparison: Comparison }
export type InvalidField = RateField | "threshold" | "customInput" | "customOutput" | "customCacheRead" | "customCacheWrite";
export type DraftOutcome = { cost: ModelCost } | { field: InvalidField };

export const MAX_RATE = 1_000_000;
export const EMPTY_RATES: RateDraft = { input: "", output: "", cacheRead: "", cacheWrite: "" };
export const EMPTY_CUSTOM: CustomDraft = { ...EMPTY_RATES, threshold: "", comparison: "gt" };
export const INVALID: unique symbol = Symbol("invalid model cost");
export const CUSTOM_FIELD: Record<RateField, InvalidField> = {
  input: "customInput", output: "customOutput", cacheRead: "customCacheRead", cacheWrite: "customCacheWrite",
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_RATE;
}
function isRates(value: unknown): value is Rates {
  return isRecord(value) && hasKeys(value, RATE_FIELDS) && RATE_FIELDS.every(field => isRate(value[field]));
}
function parsePromptLengthPricing(value: unknown): PromptLengthPricing | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return INVALID;
  if (value.mode === "automatic" && hasKeys(value, ["mode"])) return undefined;
  if (value.mode === "flat" && hasKeys(value, ["mode"])) return { mode: "flat" };
  if (value.mode !== "custom" || !Number.isSafeInteger(value.thresholdTokens) || Number(value.thresholdTokens) <= 0
    || !hasKeys(value, ["mode", "thresholdTokens", "comparison", "rates"])
    || (value.comparison !== "gt" && value.comparison !== "gte") || !isRates(value.rates)) return INVALID;
  return { mode: "custom", thresholdTokens: Number(value.thresholdTokens), comparison: value.comparison, rates: {
    input: value.rates.input, output: value.rates.output, cacheRead: value.rates.cacheRead, cacheWrite: value.rates.cacheWrite,
  } };
}

export function parseModelCost(value: unknown): ModelCost | typeof INVALID {
  if (!isRecord(value) || !hasKeys(value, Object.hasOwn(value, "promptLengthPricing")
    ? [...RATE_FIELDS, "promptLengthPricing"] : RATE_FIELDS) || !RATE_FIELDS.every(field => isRate(value[field]))) return INVALID;
  const promptLengthPricing = parsePromptLengthPricing(value.promptLengthPricing);
  if (promptLengthPricing === INVALID) return INVALID;
  const rates = Object.fromEntries(RATE_FIELDS.map(field => [field, value[field] as number])) as Rates;
  return promptLengthPricing === undefined ? rates : { ...rates, promptLengthPricing };
}

export function sameModelCost(left: ModelCost, right: ModelCost): boolean {
  if (!RATE_FIELDS.every(field => left[field] === right[field])) return false;
  const a = left.promptLengthPricing ?? { mode: "automatic" as const };
  const b = right.promptLengthPricing ?? { mode: "automatic" as const };
  if (a.mode !== b.mode) return false;
  return a.mode !== "custom" || (b.mode === "custom" && a.thresholdTokens === b.thresholdTokens
    && a.comparison === b.comparison && RATE_FIELDS.every(field => a.rates[field] === b.rates[field]));
}

export function receiptMatches(receipt: unknown, cost: ModelCost | null): boolean {
  if (cost === null) return receipt === null;
  const parsed = parseModelCost(receipt);
  return parsed !== INVALID && sameModelCost(parsed, cost);
}

const toDraft = (rates: Rates): RateDraft => Object.fromEntries(RATE_FIELDS.map(field => [field, String(rates[field])])) as RateDraft;
export function loadDraft(cost: ModelCost | undefined): { rates: RateDraft; mode: PricingMode; custom: CustomDraft } {
  if (!cost) return { rates: EMPTY_RATES, mode: "automatic", custom: EMPTY_CUSTOM };
  const pricing = cost.promptLengthPricing;
  if (!pricing || pricing.mode === "flat") return { rates: toDraft(cost), mode: pricing?.mode ?? "automatic", custom: EMPTY_CUSTOM };
  return { rates: toDraft(cost), mode: "custom", custom: {
    ...toDraft(pricing.rates), threshold: String(pricing.thresholdTokens), comparison: pricing.comparison,
  } };
}

const numberOrZero = (value: string) => value.trim() === "" ? 0 : Number(value);
export function buildDraftCost(rates: RateDraft, mode: PricingMode, custom: CustomDraft, badField?: InvalidField): DraftOutcome {
  if (badField) return { field: badField };
  if (!rates.input.trim()) return { field: "input" };
  if (!rates.output.trim()) return { field: "output" };
  const base = { input: Number(rates.input), output: Number(rates.output), cacheRead: numberOrZero(rates.cacheRead), cacheWrite: numberOrZero(rates.cacheWrite) };
  const invalidBase = RATE_FIELDS.find(field => !isRate(base[field]));
  if (invalidBase) return { field: invalidBase };
  if (mode === "automatic") return { cost: base };
  if (mode === "flat") return { cost: { ...base, promptLengthPricing: { mode: "flat" } } };
  const threshold = custom.threshold.trim();
  if (!/^[1-9]\d*$/.test(threshold) || !Number.isSafeInteger(Number(threshold))) return { field: "threshold" };
  if (!custom.input.trim()) return { field: "customInput" };
  if (!custom.output.trim()) return { field: "customOutput" };
  const band = { input: Number(custom.input), output: Number(custom.output), cacheRead: numberOrZero(custom.cacheRead), cacheWrite: numberOrZero(custom.cacheWrite) };
  const invalidBand = RATE_FIELDS.find(field => !isRate(band[field]));
  if (invalidBand) return { field: CUSTOM_FIELD[invalidBand] };
  return { cost: { ...base, promptLengthPricing: { mode: "custom", thresholdTokens: Number(threshold), comparison: custom.comparison, rates: band } } };
}
