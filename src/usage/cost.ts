/**
 * Cost estimation core (devlog/_plan/260720_toks_speed_price_columns/010).
 *
 * All prices are display-time ESTIMATES (~$), never billing reproductions:
 * - cache detail comes from provider usage as-reported (no session heuristics);
 * - matching is exact native provider/model ID via the jawcode alias table
 *   (no fuzzy, no case-fold, no resolvedModel/requestedModel fallback);
 * - user-configured provider overlay wins, then jawcode nonzero price, then the expected-price overlay
 *   (verified / verified-derived only), otherwise null => UI shows em dash;
 * - combo sums per-attempt costs and fails closed when any attempt is unpriced.
 */
import {
  findVendorCostByModelId,
  getModelMetadata,
  resolveMetadataProvider,
} from "../generated/model-metadata";
import type { AttemptTierOutcome, OcxUsage } from "../types";
import { baseProviderLabel, canonicalUsageProviderLabel } from "../providers/label";
import type { PersistedUsageAttempt, UsageStatus } from "./log";
import { canonicalAntigravityUsageModel } from "../providers/antigravity-models";
import { activeConfiguredProviders, activeUserCostOverlays, userCostOverlayVersion } from "./user-cost-overlays";
import {
  EXPECTED_PRICE_OVERLAYS,
  findExpectedPriceOverlay,
  resolvePriorityMultiplier,
  findContextTier,
  isLongContext,
  type Cost4,
  type ExpectedPriceOverlay,
  type ExpectedPriceStatus,
} from "./expected-prices";

/** Published long-context pricing band (#908). */
export type ContextTierName = "long";

/**
 * Service-tier provenance. `effectiveServiceTier()` collapses these with `??`,
 * but long-context exclusivity needs to know WHICH source supplied "priority":
 * OpenAI does not serve long context in Fast mode, so a >272k request that was
 * merely TAGGED priority was necessarily downgraded and must still be priced at
 * the long rate. Only a response-confirmed Fast tier suppresses the context tier.
 */
export interface ServiceTierContext {
  responseServiceTier?: string;
  requestedServiceTier?: string;
  configuredServiceTier?: string;
  tierOutcome?: AttemptTierOutcome;
}

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
  source: "jawcode" | "expected" | "user";
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
  /** Applied OpenAI priority-tier multiplier (undefined or 1 = standard). */
  priorityMultiplier?: number;
  /** Standard-price estimate is a known floor for a confirmed, unpriced priority endpoint. */
  priorityLowerBound?: boolean;
  /** Set when the published long-context rate was applied (#908). */
  contextTier?: ContextTierName;
}

export interface CostEstimate {
  tokens: CostTokens;
  cost: CostBreakdown;
  estimated: boolean;
  attempts?: AttemptCostEstimate[];
  price?: MatchedPrice;
  /** Applied OpenAI priority-tier multiplier (undefined or 1 = standard). */
  priorityMultiplier?: number;
  /** Standard-price estimate is a known floor for a confirmed, unpriced priority endpoint. */
  priorityLowerBound?: boolean;
  /** Set when any priced attempt used the published long-context rate (#908). */
  contextTier?: ContextTierName;
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
 * Fixed priority: user-configured provider overlay -> jawcode exact (provider
 * bundle) nonzero -> overlay verified -> overlay verified-derived -> jawcode
 * model-level vendor price (cross-provider fallback: a model follows its official
 * vendor price — WP5 policy, e.g. kiro/claude-opus-4-6 uses the anthropic price)
 * -> null. All-zero rows are overlay candidates (zero is "not billable here",
 * not "free").
 */
export function resolveMatchedPrice(
  provider: string,
  modelId: string,
  overlays: readonly ExpectedPriceOverlay[] = EXPECTED_PRICE_OVERLAYS,
  userOverlays: readonly ExpectedPriceOverlay[] = activeUserCostOverlays(),
): MatchedPrice | null {
  // User-configured overlays are keyed by the EXACT configured provider name.
  // A provider that literally exists in config.providers keeps its own pricing
  // namespace: a real custom provider can legitimately end with a label-shaped
  // suffix (e.g. acme-pabcdef) and must not inherit the base provider's user
  // overlay. Only NON-configured names (generated account log labels) collapse
  // to their label base. chatgpt/openai-multi are the same OpenAI usage surface
  // and always canonicalize to openai.
  const collapsed = baseProviderLabel(provider);
  if (collapsed !== provider && (canonicalUsageProviderLabel(provider) !== provider || !activeConfiguredProviders().has(provider))) {
    const exactUserOverlay = userOverlayMatch(provider, modelId, userOverlays);
    if (exactUserOverlay) return exactUserOverlay;
    // Pool/account log suffixes (e.g. google-antigravity-p442fff) must collapse
    // before the compiled/overlay lookup; configured providers keep their own
    // namespace above.
    provider = collapsed;
  }
  // Memoize by (provider, model): usage summaries iterate hundreds of thousands of
  // rows that share a handful of provider/model keys, so resolving each time would
  // dominate /api/usage latency (WP6 audit). The compiled overlays are static;
  // user overlays get a NEW array identity + version bump on every config refresh,
  // so memoized rows never go stale.
  if (overlays === EXPECTED_PRICE_OVERLAYS && userOverlays === activeUserCostOverlays()) {
    const cacheKey = `${userCostOverlayVersion()} ${provider} ${modelId}`;
    if (!priceMemo.has(cacheKey)) {
      if (priceMemo.size >= 512) priceMemo.clear();
      priceMemo.set(cacheKey, resolveMatchedPriceInner(provider, modelId, overlays, userOverlays));
    }
    return priceMemo.get(cacheKey)!;
  }
  return resolveMatchedPriceInner(provider, modelId, overlays, userOverlays);
}

const priceMemo = new Map<string, MatchedPrice | null>();

/**
 * Resolution wrapper: exact provider/model lookup first, then the Antigravity
 * base-model fallback for collapsed wire ids. Never falls through to the
 * cross-provider vendor price at this level.
 */
function resolveMatchedPriceInner(
  provider: string,
  modelId: string,
  overlays: readonly ExpectedPriceOverlay[],
  userOverlays: readonly ExpectedPriceOverlay[],
): MatchedPrice | null {
  const direct = resolveMatchedPriceExact(provider, modelId, overlays, userOverlays);
  if (direct) return direct;
  // Antigravity historical/wire ids often lack an exact overlay; fall back to the
  // picker/call base model so collapsed usage rows still get a price.
  if (provider === "google-antigravity" || provider.startsWith("google-antigravity")) {
    const base = canonicalAntigravityUsageModel(modelId);
    if (base !== modelId) return resolveMatchedPriceExact(provider, base, overlays, userOverlays);
  }
  return null;
}

/**
 * Exact provider/model price lookup: user-configured `modelCosts` first, then
 * the jawcode provider bundle, then the expected-price overlay, then the
 * model-level vendor fallback. All-zero rows fall through ("not billable").
 */
function resolveMatchedPriceExact(
  provider: string,
  modelId: string,
  overlays: readonly ExpectedPriceOverlay[],
  userOverlays: readonly ExpectedPriceOverlay[],
): MatchedPrice | null {
  // User-configured provider overlay wins over every compiled catalog: the
  // operator's explicit price is authoritative for the ~$ estimate.
  const userOverlay = userOverlayMatch(provider, modelId, userOverlays);
  if (userOverlay) return userOverlay;
  const metadataProvider = resolveMetadataProvider(provider);
  const bundled = metadataProvider
    ? getModelMetadata(metadataProvider, modelId)
    : undefined;
  if (bundled?.cost && validCost4(bundled.cost) && hasNonZeroCost(bundled.cost)) {
    return {
      provider,
      modelId,
      jawcodeProvider: metadataProvider,
      cost4: bundled.cost,
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
    ...(metadataProvider ? { jawcodeProvider: metadataProvider } : {}),
    cost4: overlay.cost4,
    source: "expected",
    sourceRef: overlay.source,
    verifiedAt: overlay.verifiedAt,
    status: overlay.status,
  };
}

/** User-configured overlay match (all-zero rows fall through like any other source). */
function userOverlayMatch(
  provider: string,
  modelId: string,
  userOverlays: readonly ExpectedPriceOverlay[],
): MatchedPrice | null {
  const overlay = findExpectedPriceOverlay(provider, modelId, userOverlays);
  if (!overlay || !validCost4(overlay.cost4) || !hasNonZeroCost(overlay.cost4)) return null;
  return {
    provider,
    modelId,
    cost4: overlay.cost4,
    source: "user",
    sourceRef: overlay.source,
    verifiedAt: overlay.verifiedAt,
    status: "verified",
  };
}

function resolveModelLevelPrice(provider: string, modelId: string): MatchedPrice | null {
  // Exact first; then dot->dash variant for providers that spell vendor ids with
  // dots where the catalog uses dashes (kiro "claude-opus-4.6" vs anthropic
  // "claude-opus-4-6"). No fuzzy matching beyond this one normalization.
  const found = findVendorCostByModelId(modelId)
    ?? (modelId.includes(".") ? findVendorCostByModelId(modelId.replaceAll(".", "-")) : undefined);
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

/**
 * OpenAI provider ids eligible for service_tier "priority" price multipliers.
 * Only canonical OpenAI forward providers use the priority tier; routed providers
 * (OpenRouter, Cursor, etc.) may share model slugs but have independent pricing.
 */
const OPENAI_TIER_PROVIDER_IDS = new Set(["openai", "openai-apikey"]);

/**
 * Resolve the effective service tier from persisted log fields.
 * Priority: responseServiceTier (server-confirmed) > requestedServiceTier
 * (client-sent, pre-rewrite) > configuredServiceTier (config.fastMode injection).
 */
export function effectiveServiceTier(entry: {
  responseServiceTier?: string;
  requestedServiceTier?: string;
  configuredServiceTier?: string;
}): string | undefined {
  return entry.responseServiceTier ?? entry.requestedServiceTier ?? entry.configuredServiceTier;
}

/**
 * Accepts either the collapsed tier scalar or the full provenance record.
 * A bare string carries no provenance, so it cannot confirm Fast: callers that
 * need long-context exclusivity to be correct must pass the record.
 */
export type ServiceTierInput = string | ServiceTierContext;

/**
 * Narrow a persisted log entry to just its tier provenance. Prefer this over
 * `effectiveServiceTier()` at estimator call sites: the collapsed scalar cannot
 * distinguish a response-confirmed Fast request from a merely requested one,
 * and long-context exclusivity depends on that distinction.
 */
export function serviceTierContext(entry: ServiceTierContext): ServiceTierContext {
  if (entry.tierOutcome) {
    return { ...serviceTierContextFromOutcome(entry.tierOutcome), tierOutcome: entry.tierOutcome };
  }
  return {
    responseServiceTier: entry.responseServiceTier,
    requestedServiceTier: entry.requestedServiceTier,
    configuredServiceTier: entry.configuredServiceTier,
  };
}

/** Convert one adapter-observed attempt outcome into the existing pricing provenance shape. */
export function serviceTierContextFromOutcome(outcome: AttemptTierOutcome): ServiceTierContext {
  if (outcome.canonical === "priority" && outcome.confirmation === "confirmed") {
    return { responseServiceTier: "priority" };
  }
  if (outcome.responseServiceTier !== undefined) {
    return { responseServiceTier: outcome.responseServiceTier };
  }
  if (outcome.canonical === "priority" && outcome.confirmation === "assumed") {
    return { requestedServiceTier: "priority" };
  }
  // An unclassified route makes no canonical Fast claim, but its adapter can still prove that
  // it serialized a caller tier. Preserve that wire evidence instead of discarding the legacy
  // top-level pricing signal merely because B0 added an outcome row.
  if (
    outcome.fastOutcome === "unknown"
    && outcome.wireKind === "service-tier"
    && typeof outcome.wireValue === "string"
  ) {
    return { requestedServiceTier: outcome.wireValue };
  }
  return {};
}

function tierScalar(tier?: ServiceTierInput): string | undefined {
  return typeof tier === "string" ? tier : tier && effectiveServiceTier(tier);
}

/** True only when the UPSTREAM RESPONSE confirmed the Fast tier (see ServiceTierContext). */
function isConfirmedFast(tier?: ServiceTierInput): boolean {
  return typeof tier === "object" && tier.responseServiceTier === "priority";
}

/**
 * Apply the published long-context rate when raw prompt size crosses the vendor
 * threshold. Returns [effectiveCost4, tierName].
 *
 * `rawInputTokens` MUST be `usage.inputTokens` (total prompt size), never the
 * normalized billable input — normalization subtracts cache read/write, so a
 * cache-heavy long prompt would fall below the boundary and under-bill.
 *
 * Skipped entirely for a response-confirmed Fast request: OpenAI does not serve
 * long context in Fast mode, so the two are mutually exclusive regimes rather
 * than composable multipliers.
 */
function applyContextTier(
  cost4: Cost4,
  provider: string,
  modelId: string,
  rawInputTokens: number | undefined,
  tier?: ServiceTierInput,
): [Cost4, ContextTierName | undefined] {
  if (rawInputTokens === undefined) return [cost4, undefined];
  if (isConfirmedFast(tier)) return [cost4, undefined];
  const rule = findContextTier(baseProviderLabel(provider), modelId);
  if (!rule || !isLongContext(rule, rawInputTokens)) return [cost4, undefined];
  return [{
    input: cost4.input * rule.multiplier.input,
    output: cost4.output * rule.multiplier.output,
    cacheRead: cost4.cacheRead * rule.multiplier.cacheRead,
    cacheWrite: cost4.cacheWrite * rule.multiplier.cacheWrite,
  }, "long"];
}

/**
 * Apply the OpenAI priority-tier multiplier to a Cost4 when applicable.
 * Returns [effectiveCost4, multiplier]. Multiplier is 1 (no-op) when:
 * - serviceTier is not "priority"
 * - provider is not a canonical OpenAI forward provider
 * - model is not in PRIORITY_MULTIPLIERS
 */
function applyPriorityMultiplier(
  cost4: Cost4,
  provider: string,
  modelId: string,
  serviceTier?: ServiceTierInput,
): [Cost4, number] {
  if (tierScalar(serviceTier) !== "priority") return [cost4, 1];
  const base = baseProviderLabel(provider);
  if (!OPENAI_TIER_PROVIDER_IDS.has(base)) return [cost4, 1];
  const multiplier = resolvePriorityMultiplier(modelId);
  if (multiplier === 1) return [cost4, 1];
  return [{
    input: cost4.input * multiplier,
    output: cost4.output * multiplier,
    cacheRead: cost4.cacheRead * multiplier,
    cacheWrite: cost4.cacheWrite * multiplier,
  }, multiplier];
}

/**
 * OpenRouter confirms the actual endpoint tier and documents priority as higher cost, but this
 * branch does not bundle its provider-specific priority endpoint prices. A confirmed canonical
 * priority result can therefore use the standard price only as a provable lower bound. Do not
 * extend this to flex (cheaper) or to other providers without the same pricing contract.
 *
 * An ASSUMED priority attempt needs the same marker for a different reason. There the provider
 * never echoed a tier at all, so the standard price is not merely a lower bound on a known
 * premium — it is a floor under an outcome we did not observe. Returning it unmarked reports a
 * definite standard cost for a request that may well have been billed as priority, which is the
 * one thing a cost estimate must never do.
 */
function isOpenRouterPriorityLowerBound(
  provider: string,
  outcome: AttemptTierOutcome | undefined,
): boolean {
  return baseProviderLabel(provider) === "openrouter"
    && outcome?.canonical === "priority"
    && outcome.fastOutcome === "applied"
    && (outcome.confirmation === "confirmed" || outcome.confirmation === "assumed");
}

/**
 * Per-attempt cost estimate: tokens normalized, price resolved (user overlay →
 * catalogs), priority/long-context tiers applied. Null when usage or price is
 * missing so combos can fail closed.
 */
export function estimateAttemptCost(
  attempt: Pick<PersistedUsageAttempt, "ordinal" | "provider" | "model" | "usage" | "usageStatus" | "tierOutcome">,
  overlays: readonly ExpectedPriceOverlay[] = EXPECTED_PRICE_OVERLAYS,
  serviceTier?: ServiceTierInput,
  userOverlays: readonly ExpectedPriceOverlay[] = activeUserCostOverlays(),
): AttemptCostEstimate | null {
  if (!attempt.usage) return null;
  const tokens = normalizeCostTokens(attempt.usage);
  if (!tokens) return null;
  const price = resolveMatchedPrice(attempt.provider, attempt.model, overlays, userOverlays);
  if (!price) return null;
  const attemptServiceTier = attempt.tierOutcome
    ? serviceTierContextFromOutcome(attempt.tierOutcome)
    : serviceTier;
  const [tieredCost4, contextTier] = applyContextTier(
    price.cost4, attempt.provider, attempt.model, attempt.usage.inputTokens, attemptServiceTier,
  );
  // Exclusive both ways: if the long rate applied, the request was NOT served as
  // Fast (Fast does not support long context), so the Fast multiplier must not
  // also apply — otherwise a downgraded request bills at both rates.
  const [effectiveCost4, multiplier] = contextTier
    ? [tieredCost4, 1] as const
    : applyPriorityMultiplier(tieredCost4, attempt.provider, attempt.model, attemptServiceTier);
  const priorityLowerBound = isOpenRouterPriorityLowerBound(attempt.provider, attempt.tierOutcome);
  return {
    ordinal: attempt.ordinal,
    provider: attempt.provider,
    model: attempt.model,
    tokens,
    price,
    cost: calculateCost(tokens, effectiveCost4),
    estimated: isEstimated(attempt.usage, attempt.usageStatus, price.status),
    ...(multiplier !== 1 ? { priorityMultiplier: multiplier } : {}),
    ...(priorityLowerBound ? { priorityLowerBound: true } : {}),
    ...(contextTier ? { contextTier } : {}),
  };
}

/**
 * Combo: price every attempt with its own rate and sum. Fail closed — if ANY
 * attempt is unpriced or unnormalizable, return null rather than a partial sum.
 */
export function estimateComboCost(
  attempts: readonly Pick<PersistedUsageAttempt, "ordinal" | "provider" | "model" | "usage" | "usageStatus" | "tierOutcome">[],
  overlays: readonly ExpectedPriceOverlay[] = EXPECTED_PRICE_OVERLAYS,
  serviceTier?: ServiceTierInput,
  userOverlays: readonly ExpectedPriceOverlay[] = activeUserCostOverlays(),
): CostEstimate | null {
  if (attempts.length === 0) return null;
  const estimates: AttemptCostEstimate[] = [];
  for (const attempt of attempts) {
    const estimate = estimateAttemptCost(attempt, overlays, serviceTier, userOverlays);
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
    ...(estimates.some(est => est.priorityMultiplier && est.priorityMultiplier !== 1)
      ? { priorityMultiplier: estimates.find(est => est.priorityMultiplier)?.priorityMultiplier }
      : {}),
    ...(estimates.some(est => est.priorityLowerBound) ? { priorityLowerBound: true } : {}),
    ...(estimates.some(est => est.contextTier) ? { contextTier: "long" as const } : {}),
  };
}

/** Single-target request cost estimate (non-combo). */
export function estimateRequestCost(
  input: {
    provider: string;
    model: string;
    usage?: OcxUsage;
    usageStatus: UsageStatus;
    serviceTier?: ServiceTierInput;
  },
  overlays: readonly ExpectedPriceOverlay[] = EXPECTED_PRICE_OVERLAYS,
  userOverlays: readonly ExpectedPriceOverlay[] = activeUserCostOverlays(),
): CostEstimate | null {
  if (!input.usage) return null;
  const tokens = normalizeCostTokens(input.usage);
  if (!tokens) return null;
  const price = resolveMatchedPrice(input.provider, input.model, overlays, userOverlays);
  if (!price) return null;
  const [tieredCost4, contextTier] = applyContextTier(
    price.cost4, input.provider, input.model, input.usage.inputTokens, input.serviceTier,
  );
  const [effectiveCost4, multiplier] = contextTier
    ? [tieredCost4, 1] as const
    : applyPriorityMultiplier(tieredCost4, input.provider, input.model, input.serviceTier);
  const priorityLowerBound = isOpenRouterPriorityLowerBound(
    input.provider,
    typeof input.serviceTier === "object" ? input.serviceTier.tierOutcome : undefined,
  );
  return {
    tokens,
    price,
    cost: calculateCost(tokens, effectiveCost4),
    estimated: isEstimated(input.usage, input.usageStatus, price.status),
    ...(multiplier !== 1 ? { priorityMultiplier: multiplier } : {}),
    ...(priorityLowerBound ? { priorityLowerBound: true } : {}),
    ...(contextTier ? { contextTier } : {}),
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
