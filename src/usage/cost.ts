/**
 * Cost estimation core (devlog/_plan/260720_toks_speed_price_columns/010).
 *
 * All prices are display-time ESTIMATES (~$), never billing reproductions:
 * - cache detail comes from provider usage as-reported (no session heuristics);
 * - matching is exact native provider/model ID via the jawcode alias table
 *   (no fuzzy, no case-fold, no resolvedModel/requestedModel fallback);
 * - jawcode nonzero price wins, then the expected-price overlay
 *   (verified / verified-derived only), otherwise null => UI shows em dash;
 * - combo sums per-attempt costs and fails closed when any attempt is unpriced.
 */
import {
  findJawcodeCostByModelId,
  getJawcodeModelMetadata,
  resolveJawcodeProvider,
} from "../generated/jawcode-model-metadata";
import type { OcxUsage } from "../types";
import type { PersistedUsageAttempt, UsageStatus } from "./log";
import {
  EXPECTED_PRICE_OVERLAYS,
  findExpectedPriceOverlay,
  type Cost4,
  type ExpectedPriceOverlay,
  type ExpectedPriceStatus,
} from "./expected-prices";

export interface CostTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface MatchedPrice {
  provider: string;
  modelId: string;
  jawcodeProvider?: string;
  cost4: Cost4;
  source: "jawcode" | "expected";
  sourceRef?: string;
  verifiedAt?: string;
  status: "verified" | "verified-derived";
}

export interface AttemptCostEstimate {
  ordinal: number;
  provider: string;
  model: string;
  tokens: CostTokens;
  price: MatchedPrice;
  cost: CostBreakdown;
  estimated: boolean;
}

export interface CostEstimate {
  tokens: CostTokens;
  cost: CostBreakdown;
  estimated: boolean;
  attempts?: AttemptCostEstimate[];
  price?: MatchedPrice;
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function validCost4(cost: Cost4 | undefined): cost is Cost4 {
  return !!cost
    && finiteNonNegative(cost.input)
    && finiteNonNegative(cost.output)
    && finiteNonNegative(cost.cacheRead)
    && finiteNonNegative(cost.cacheWrite);
}

function hasNonZeroCost(cost: Cost4): boolean {
  return cost.input !== 0 || cost.output !== 0
    || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
}

/**
 * Normalize inclusive OcxUsage (types.ts: inputTokens INCLUDES cache read/write)
 * into jawcode CostTokens (input = uncached prompt only) without double-charging.
 *
 * Canonical-first with a single legacy retry: the canonical contract says
 * `cachedInputTokens` is read-only tokens, but legacy claude-route rows stored
 * read+write combined there (devlog 070). The two shapes are indistinguishable
 * by fields alone, so we apply the canonical reading first and only when it
 * produces an impossible R+W>I do we retry the legacy recovery
 * (cached - creation). If both readings are contradictory, fail closed (null).
 */
export function normalizeCostTokens(usage: OcxUsage): CostTokens | null {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const primaryRead = usage.cacheReadInputTokens ?? usage.cachedInputTokens ?? 0;
  const candidates: number[] = [primaryRead];
  if (typeof usage.cacheReadInputTokens !== "number"
    && typeof usage.cachedInputTokens === "number"
    && typeof usage.cacheCreationInputTokens === "number") {
    candidates.push(Math.max(0, usage.cachedInputTokens - usage.cacheCreationInputTokens));
  }
  for (const cacheRead of candidates) {
    if (![input, output, cacheRead, cacheWrite].every(finiteNonNegative)) return null;
    if (cacheRead + cacheWrite > input) continue;
    return {
      input: Math.max(0, input - cacheRead - cacheWrite),
      output,
      cacheRead,
      cacheWrite,
    };
  }
  return null;
}

/** jawcode unit convention: USD per 1M tokens (jawcode stats/db.ts calculateCatalogCost). */
export function calculateCost(tokens: CostTokens, cost4: Cost4): CostBreakdown {
  const input = cost4.input * tokens.input / 1_000_000;
  const output = cost4.output * tokens.output / 1_000_000;
  const cacheRead = cost4.cacheRead * tokens.cacheRead / 1_000_000;
  const cacheWrite = cost4.cacheWrite * tokens.cacheWrite / 1_000_000;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/**
 * Fixed priority: jawcode exact (provider bundle) nonzero -> overlay verified ->
 * overlay verified-derived -> jawcode model-level vendor price (cross-provider
 * fallback: a model follows its official vendor price — WP5 policy, e.g.
 * kiro/claude-opus-4-6 uses the anthropic price) -> null. All-zero jawcode rows
 * are overlay candidates (zero is "not billable here", not "free").
 */
export function resolveMatchedPrice(
  provider: string,
  modelId: string,
  overlays: readonly ExpectedPriceOverlay[] = EXPECTED_PRICE_OVERLAYS,
): MatchedPrice | null {
  const jawcodeProvider = resolveJawcodeProvider(provider);
  const jawcode = jawcodeProvider
    ? getJawcodeModelMetadata(jawcodeProvider, modelId)
    : undefined;
  if (jawcode?.cost && validCost4(jawcode.cost) && hasNonZeroCost(jawcode.cost)) {
    return {
      provider,
      modelId,
      jawcodeProvider,
      cost4: jawcode.cost,
      source: "jawcode",
      status: "verified",
    };
  }
  const overlay = findExpectedPriceOverlay(provider, modelId, overlays);
  if (!overlay || !validCost4(overlay.cost4) || !hasNonZeroCost(overlay.cost4)) {
    return resolveModelLevelPrice(provider, modelId);
  }
  if (overlay.status === "unverified") return null;
  return {
    provider,
    modelId,
    ...(jawcodeProvider ? { jawcodeProvider } : {}),
    cost4: overlay.cost4,
    source: "expected",
    sourceRef: overlay.source,
    verifiedAt: overlay.verifiedAt,
    status: overlay.status,
  };
}

function resolveModelLevelPrice(provider: string, modelId: string): MatchedPrice | null {
  // Exact first; then dot->dash variant for providers that spell vendor ids with
  // dots where the catalog uses dashes (kiro "claude-opus-4.6" vs anthropic
  // "claude-opus-4-6"). No fuzzy matching beyond this one normalization.
  const found = findJawcodeCostByModelId(modelId)
    ?? (modelId.includes(".") ? findJawcodeCostByModelId(modelId.replaceAll(".", "-")) : undefined);
  if (!found) return null;
  return {
    provider,
    modelId,
    jawcodeProvider: found.provider,
    cost4: found.cost,
    source: "jawcode",
    status: "verified-derived",
  };
}

function isEstimated(usage: OcxUsage, usageStatus: UsageStatus, priceStatus: ExpectedPriceStatus | "verified"): boolean {
  return usage.estimated === true || usageStatus === "estimated" || priceStatus === "verified-derived";
}

export function estimateAttemptCost(
  attempt: Pick<PersistedUsageAttempt, "ordinal" | "provider" | "model" | "usage" | "usageStatus">,
  overlays: readonly ExpectedPriceOverlay[] = EXPECTED_PRICE_OVERLAYS,
): AttemptCostEstimate | null {
  if (!attempt.usage) return null;
  const tokens = normalizeCostTokens(attempt.usage);
  if (!tokens) return null;
  const price = resolveMatchedPrice(attempt.provider, attempt.model, overlays);
  if (!price) return null;
  return {
    ordinal: attempt.ordinal,
    provider: attempt.provider,
    model: attempt.model,
    tokens,
    price,
    cost: calculateCost(tokens, price.cost4),
    estimated: isEstimated(attempt.usage, attempt.usageStatus, price.status),
  };
}

/**
 * Combo: price every attempt with its own rate and sum. Fail closed — if ANY
 * attempt is unpriced or unnormalizable, return null rather than a partial sum.
 */
export function estimateComboCost(
  attempts: readonly Pick<PersistedUsageAttempt, "ordinal" | "provider" | "model" | "usage" | "usageStatus">[],
  overlays: readonly ExpectedPriceOverlay[] = EXPECTED_PRICE_OVERLAYS,
): CostEstimate | null {
  if (attempts.length === 0) return null;
  const estimates: AttemptCostEstimate[] = [];
  for (const attempt of attempts) {
    const estimate = estimateAttemptCost(attempt, overlays);
    if (!estimate) return null;
    estimates.push(estimate);
  }
  const tokens: CostTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const cost: CostBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  for (const est of estimates) {
    tokens.input += est.tokens.input;
    tokens.output += est.tokens.output;
    tokens.cacheRead += est.tokens.cacheRead;
    tokens.cacheWrite += est.tokens.cacheWrite;
    cost.input += est.cost.input;
    cost.output += est.cost.output;
    cost.cacheRead += est.cost.cacheRead;
    cost.cacheWrite += est.cost.cacheWrite;
    cost.total += est.cost.total;
  }
  return {
    tokens,
    cost,
    estimated: estimates.some(est => est.estimated),
    attempts: estimates,
  };
}

/** Single-target request cost estimate (non-combo). */
export function estimateRequestCost(
  input: {
    provider: string;
    model: string;
    usage?: OcxUsage;
    usageStatus: UsageStatus;
  },
  overlays: readonly ExpectedPriceOverlay[] = EXPECTED_PRICE_OVERLAYS,
): CostEstimate | null {
  if (!input.usage) return null;
  const tokens = normalizeCostTokens(input.usage);
  if (!tokens) return null;
  const price = resolveMatchedPrice(input.provider, input.model, overlays);
  if (!price) return null;
  return {
    tokens,
    price,
    cost: calculateCost(tokens, price.cost4),
    estimated: isEstimated(input.usage, input.usageStatus, price.status),
  };
}

/**
 * End-to-end output rate: outputTokens / wall-clock seconds (jawcode/OpenRouter
 * convention — TTFT is NOT subtracted; it is a separate metric, WP4).
 */
export function tokensPerSecond(outputTokens: number, durationMs: number): number | null {
  if (!finiteNonNegative(outputTokens) || !finiteNonNegative(durationMs)) return null;
  if (outputTokens <= 0 || durationMs <= 0) return null;
  return outputTokens / (durationMs / 1_000);
}
