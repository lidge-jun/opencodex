import type { CatalogModel } from "../codex/catalog";
import {
  getJawcodeModelMetadata,
  getJawcodeModelMetadataCaseInsensitive,
  resolveJawcodeProvider,
} from "../generated/jawcode-model-metadata";
import type { OcxComboConfig, OcxConfig } from "../types";
import { slugEquals } from "../providers/slug-codec";
import { findExpectedPriceOverlay } from "../usage/expected-prices";

export type SmartRoutingMode = "intelligence" | "balance" | "cost";

export const SMART_ROUTING_MODES: readonly SmartRoutingMode[] = ["intelligence", "balance", "cost"];
export const SMART_ROUTING_PROFILE_VERIFIED_AT = "2026-07-24";

interface CapabilityProfile {
  pattern: RegExp;
  coding: number;
  agent: number;
  tools: number;
  reasoning: number;
  instruction: number;
  confidence: number;
}

interface RankedModel {
  model: CatalogModel;
  quality: number;
  cost?: number;
  costScore: number;
  utility: number;
}

// Scores are broad coding-agent priors, not raw benchmark averages. They intentionally keep
// model capability independent from provider-specific price and availability.
const CAPABILITY_PROFILES: readonly CapabilityProfile[] = [
  { pattern: /(?:^|\/)claude-fable-5(?:$|[-:])/, coding: .98, agent: .98, tools: .96, reasoning: .97, instruction: .94, confidence: .94 },
  { pattern: /(?:^|\/)claude-sonnet-5(?:$|[-:])/, coding: .91, agent: .92, tools: .94, reasoning: .91, instruction: .94, confidence: .86 },
  { pattern: /(?:^|\/)claude-opus-4-8(?:$|[-:])/, coding: .92, agent: .94, tools: .94, reasoning: .95, instruction: .93, confidence: .93 },
  { pattern: /(?:^|\/)claude-opus-4-[67](?:$|[-:])/, coding: .84, agent: .91, tools: .91, reasoning: .93, instruction: .91, confidence: .90 },
  { pattern: /(?:^|\/)gpt-5\.5(?:$|[-:])/, coding: .91, agent: .97, tools: .94, reasoning: .96, instruction: .92, confidence: .92 },
  { pattern: /(?:^|\/)gpt-5\.3-codex(?:$|[-:])/, coding: .94, agent: .93, tools: .93, reasoning: .91, instruction: .92, confidence: .82 },
  { pattern: /(?:^|\/)gpt-5\.6-sol(?:$|[-:])/, coding: .94, agent: .95, tools: .95, reasoning: .97, instruction: .94, confidence: .78 },
  { pattern: /(?:^|\/)gpt-5\.6-terra(?:$|[-:])/, coding: .87, agent: .88, tools: .92, reasoning: .90, instruction: .92, confidence: .74 },
  { pattern: /(?:^|\/)gpt-5\.6-luna(?:$|[-:])/, coding: .71, agent: .70, tools: .86, reasoning: .72, instruction: .87, confidence: .72 },
  { pattern: /(?:^|\/)grok-4\.5(?:$|[-:])/, coding: .91, agent: .96, tools: .92, reasoning: .91, instruction: .89, confidence: .94 },
  { pattern: /(?:^|\/)grok-4\.(?:3|20)(?:$|[-:])/, coding: .79, agent: .83, tools: .87, reasoning: .85, instruction: .86, confidence: .76 },
  { pattern: /(?:^|\/)gemini-3\.6-flash(?:$|[-:])/, coding: .84, agent: .89, tools: .92, reasoning: .86, instruction: .90, confidence: .82 },
  { pattern: /(?:^|\/)gemini-3\.5-flash-lite(?:$|[-:])/, coding: .67, agent: .68, tools: .82, reasoning: .69, instruction: .84, confidence: .78 },
  { pattern: /(?:^|\/)gemini-3\.5-flash(?:$|[-:])/, coding: .80, agent: .84, tools: .89, reasoning: .82, instruction: .88, confidence: .80 },
  { pattern: /(?:^|\/)deepseek-v4-pro(?:$|[-:])/, coding: .97, agent: .91, tools: .94, reasoning: .96, instruction: .90, confidence: .83 },
  { pattern: /(?:^|\/)deepseek-v4-flash(?:$|[-:])/, coding: .89, agent: .85, tools: .91, reasoning: .88, instruction: .88, confidence: .78 },
  { pattern: /(?:^|\/)glm-5\.2(?:$|[-:\[])/, coding: .91, agent: .94, tools: .97, reasoning: .94, instruction: .90, confidence: .84 },
  { pattern: /(?:^|\/)kimi-k3(?:$|[-:\[])/, coding: .92, agent: .93, tools: .95, reasoning: .94, instruction: .91, confidence: .82 },
  { pattern: /(?:^|\/)kimi-k2\.7-code(?:$|[-:])/, coding: .91, agent: .90, tools: .94, reasoning: .90, instruction: .90, confidence: .85 },
  { pattern: /(?:^|\/)kimi-k2\.6(?:$|[-:])/, coding: .83, agent: .86, tools: .91, reasoning: .88, instruction: .89, confidence: .80 },
  { pattern: /(?:^|\/)minimax-m3(?:$|[-:])/, coding: .82, agent: .84, tools: .88, reasoning: .83, instruction: .87, confidence: .77 },
  { pattern: /(?:^|\/)minimax-m2\.7(?:$|[-:])/, coding: .77, agent: .79, tools: .85, reasoning: .79, instruction: .84, confidence: .76 },
  { pattern: /(?:^|\/)qwen3\.[5-8](?:$|[-:\[])/, coding: .84, agent: .82, tools: .88, reasoning: .88, instruction: .87, confidence: .68 },
  { pattern: /(?:^|\/)devstral-(?:2512|latest)(?:$|[-:])/, coding: .82, agent: .83, tools: .87, reasoning: .79, instruction: .86, confidence: .62 },
  { pattern: /(?:^|\/)mistral-(?:large|medium)(?:$|[-:])/, coding: .75, agent: .76, tools: .85, reasoning: .80, instruction: .86, confidence: .60 },
  { pattern: /(?:^|\/)command-a-plus(?:$|[-:])/, coding: .70, agent: .78, tools: .89, reasoning: .75, instruction: .88, confidence: .75 },
  { pattern: /(?:^|\/)nvidia-nemotron-3-(?:super|ultra)(?:$|[-:])/, coding: .84, agent: .85, tools: .88, reasoning: .90, instruction: .85, confidence: .76 },
  { pattern: /(?:^|\/)longcat-2\.0(?:$|[-:])/, coding: .84, agent: .86, tools: .88, reasoning: .87, instruction: .85, confidence: .72 },
  { pattern: /(?:^|\/)llama-4-maverick(?:$|[-:])/, coding: .70, agent: .70, tools: .80, reasoning: .76, instruction: .84, confidence: .69 },
  { pattern: /(?:^|\/)hermes-4-(?:405b|70b)(?:$|[-:])/, coding: .74, agent: .64, tools: .76, reasoning: .87, instruction: .84, confidence: .70 },
  { pattern: /(?:^|\/)lfm2-24b-a2b(?:$|[-:])/, coding: .28, agent: .50, tools: .78, reasoning: .42, instruction: .77, confidence: .88 },
];

function metadata(provider: string, modelId: string) {
  const resolved = resolveJawcodeProvider(provider);
  for (const candidate of new Set([provider, resolved].filter((value): value is string => Boolean(value)))) {
    const found = getJawcodeModelMetadata(candidate, modelId)
      ?? getJawcodeModelMetadataCaseInsensitive(candidate, modelId);
    if (found) return found;
  }
  return undefined;
}

function modelCost(config: OcxConfig, model: CatalogModel): number | undefined {
  const provider = config.providers[model.provider];
  if (provider?.authMode === "local") return 0;
  const metaCost = metadata(model.provider, model.id)?.cost;
  const overlay = findExpectedPriceOverlay(model.provider, model.id)?.cost4;
  const cost = overlay
    ?? (metaCost && Object.values(metaCost).some(value => value > 0) ? metaCost : undefined);
  if (!cost || !Object.values(cost).some(value => value > 0)) return undefined;
  return cost.input + cost.output * 2;
}

function fallbackProfile(model: CatalogModel): Omit<CapabilityProfile, "pattern"> {
  const meta = metadata(model.provider, model.id);
  const reasoning = (model.reasoningEfforts?.length ?? 0) > 0 || meta?.reasoning === true;
  return {
    coding: reasoning ? .56 : .48,
    agent: reasoning ? .55 : .47,
    tools: .50,
    reasoning: reasoning ? .62 : .43,
    instruction: .55,
    confidence: .32,
  };
}

function modelQuality(model: CatalogModel, mode: SmartRoutingMode): number {
  const id = model.id.toLowerCase();
  const profile = CAPABILITY_PROFILES.find(candidate => candidate.pattern.test(id)) ?? fallbackProfile(model);
  const broad = profile.coding * .34
    + profile.agent * .27
    + profile.tools * .18
    + profile.reasoning * .14
    + profile.instruction * .07;
  const uncertainty = (1 - profile.confidence) * (mode === "intelligence" ? .20 : mode === "balance" ? .12 : .08);
  return Math.max(0, broad - uncertainty);
}

function costScores(costs: readonly number[]): (cost: number | undefined) => number {
  const known = [...costs].sort((a, b) => a - b);
  if (known.length === 0) return () => 0;
  const low = known[Math.floor((known.length - 1) * .1)] ?? known[0]!;
  const high = known[Math.ceil((known.length - 1) * .9)] ?? known.at(-1)!;
  const min = Math.log(low + .1);
  const range = Math.max(.01, Math.log(high + .1) - min);
  return cost => cost === undefined ? 0 : 1 - Math.min(1, Math.max(0, (Math.log(cost + .1) - min) / range));
}

function utility(mode: SmartRoutingMode, quality: number, costScore: number): number {
  if (mode === "intelligence") return quality * .93 + costScore * .07;
  if (mode === "balance") return quality * .65 + costScore * .35;
  return quality * .34 + costScore * .66;
}

export function buildSmartRoutingCombo(
  mode: SmartRoutingMode,
  models: readonly CatalogModel[],
  config: OcxConfig,
): OcxComboConfig | null {
  const eligible = models
    .filter(model => model.provider !== "combo" && config.providers[model.provider]?.disabled !== true)
    .filter(model => config.providers[model.provider] !== undefined)
    .filter(model => !(config.disabledModels ?? []).some(disabled => slugEquals(disabled, model.provider, model.id)))
    .filter(model => (model.contextWindow ?? metadata(model.provider, model.id)?.contextWindow ?? 32_000) >= 32_000)
    .map(model => ({ model, quality: modelQuality(model, mode), cost: modelCost(config, model) }));
  const scoreCost = costScores(eligible.flatMap(candidate => candidate.cost === undefined ? [] : [candidate.cost]));
  const scored = eligible.map(candidate => {
    const costScore = scoreCost(candidate.cost);
    return { ...candidate, costScore, utility: utility(mode, candidate.quality, costScore) };
  });
  const bestQuality = Math.max(0, ...scored.map(candidate => candidate.quality));
  const capable = mode === "cost"
    ? scored.filter(candidate => candidate.cost !== undefined && candidate.quality >= Math.max(.48, bestQuality - .18))
    : scored;
  const byProvider = new Map<string, RankedModel>();
  for (const candidate of capable) {
    const current = byProvider.get(candidate.model.provider);
    if (!current || candidate.utility > current.utility
      || (candidate.utility === current.utility && candidate.quality > current.quality)
      || (candidate.utility === current.utility && candidate.quality === current.quality
        && candidate.model.id.localeCompare(current.model.id) < 0)) {
      byProvider.set(candidate.model.provider, candidate);
    }
  }
  const ranked = [...byProvider.values()]
    .sort((a, b) => b.utility - a.utility
      || b.quality - a.quality
      || a.model.provider.localeCompare(b.model.provider)
      || a.model.id.localeCompare(b.model.id))
    .slice(0, 8);
  if (ranked.length === 0) return null;
  const top = ranked[0]!.utility;
  return {
    strategy: "round-robin",
    stickyLimit: 1,
    defaultEffort: mode === "intelligence" ? "high" : mode === "balance" ? "medium" : "low",
    targets: ranked.map(candidate => ({
      provider: candidate.model.provider,
      model: candidate.model.id,
      weight: Math.max(1, Math.round(10 * candidate.utility / top)),
    })),
  };
}
