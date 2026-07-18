import type { OcxProviderConfig } from "./types";
import { modelInList } from "./types";

// Descriptions mirror the upstream bundled models.json canonical wording (openai/codex PR #31684).
export const CODEX_REASONING_LEVELS: { effort: string; description: string }[] = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
  { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
  { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
  { effort: "ultra", description: "Maximum reasoning with automatic task delegation" },
];

const CODEX_REASONING_ORDER = CODEX_REASONING_LEVELS.map(l => l.effort);
const CODEX_REASONING_SET = new Set(CODEX_REASONING_ORDER);

/** True when `effort` is a member of the Codex reasoning ladder (low..ultra). */
export function isCodexReasoningEffort(effort: string): boolean {
  return CODEX_REASONING_SET.has(effort);
}

/** Position of `effort` in the Codex ladder (low=0 .. ultra=5), or -1 when not a ladder member. */
export function codexEffortRank(effort: string): number {
  return CODEX_REASONING_ORDER.indexOf(effort);
}

export function modelRecordValue<T>(record: Record<string, T> | undefined, modelId: string): T | undefined {
  if (!record) return undefined;
  if (Object.prototype.hasOwnProperty.call(record, modelId)) return record[modelId];
  const colon = modelId.indexOf(":");
  if (colon > 0) {
    const family = modelId.slice(0, colon);
    if (Object.prototype.hasOwnProperty.call(record, family)) return record[family];
  }
  const folded = modelId.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === folded) return value;
  }
  return undefined;
}

export function sanitizeCodexReasoningEfforts(efforts: readonly string[] | undefined): string[] | undefined {
  if (efforts === undefined) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const effort of efforts) {
    if (!CODEX_REASONING_SET.has(effort) || seen.has(effort)) continue;
    seen.add(effort);
    out.push(effort);
  }
  return out.sort((a, b) => CODEX_REASONING_ORDER.indexOf(a) - CODEX_REASONING_ORDER.indexOf(b));
}

/**
 * Provider/model configured reasoning levels for the Codex catalog. `undefined` means “no override”,
 * while an empty array means “intentionally expose no effort control for this model”.
 */
export function configuredReasoningEfforts(provider: OcxProviderConfig, modelId: string): string[] | undefined {
  if (modelInList(provider.noReasoningModels, modelId)) return [];
  const modelEfforts = modelRecordValue(provider.modelReasoningEfforts, modelId);
  if (modelEfforts !== undefined) return healMappedTiers(provider, modelId, sanitizeCodexReasoningEfforts(modelEfforts) ?? []);
  if (provider.reasoningEfforts !== undefined) return healMappedTiers(provider, modelId, sanitizeCodexReasoningEfforts(provider.reasoningEfforts) ?? []);
  return undefined;
}

/**
 * Stale-ladder self-heal: a registry wire map is authoritative evidence of the upstream tiers
 * it can emit. Merge Codex-native map values into an older persisted ladder so newly documented
 * tiers appear without rewriting the user's config. Non-Codex values such as enabled/disabled
 * and Kimi's none sentinel are ignored here; they remain request-only wire aliases.
 */
function healMappedTiers(provider: OcxProviderConfig, modelId: string, efforts: string[]): string[] {
  if (efforts.length === 0) return efforts;
  const wireMap = reasoningEffortMapFor(provider, modelId);
  if (!wireMap) return efforts;
  const mappedTiers = Object.values(wireMap).filter(isCodexReasoningEffort);
  if (mappedTiers.length === 0) return efforts;
  return sanitizeCodexReasoningEfforts([...efforts, ...mappedTiers]) ?? efforts;
}

function requestToCodexEffort(requested: string): string | undefined {
  if (requested === "none") return undefined;
  if (requested === "minimal") return "low";
  return CODEX_REASONING_SET.has(requested) ? requested : undefined;
}

function clampToSupportedCodexEffort(requested: string, supported: readonly string[]): string | undefined {
  if (supported.length === 0) return undefined;
  const codex = requestToCodexEffort(requested);
  if (!codex) return undefined;
  if (supported.includes(codex)) return codex;

  const requestedRank = CODEX_REASONING_ORDER.indexOf(codex);
  let best = supported[0];
  let bestRank = CODEX_REASONING_ORDER.indexOf(best);
  for (const effort of supported) {
    const rank = CODEX_REASONING_ORDER.indexOf(effort);
    if (rank <= requestedRank && rank >= bestRank) {
      best = effort;
      bestRank = rank;
    }
  }
  // If every supported tier is above the requested tier, choose the lowest supported tier.
  return best;
}

export function reasoningEffortMapFor(provider: OcxProviderConfig, modelId: string): Record<string, string> | undefined {
  return modelRecordValue(provider.modelReasoningEffortMap, modelId) ?? provider.reasoningEffortMap;
}

/**
 * Translate Codex's reasoning label into the provider's real wire value. Prefer identity labels
 * (`xhigh` stays `xhigh`, `max` stays `max`); provider maps are only for real upstream aliases.
 */
export function mapReasoningEffort(provider: OcxProviderConfig, modelId: string, requested: string | undefined): string | undefined {
  if (!requested) return undefined;
  if (modelInList(provider.noReasoningModels, modelId)) return undefined;

  // Upstream codex-rs converts ultra -> max before ANY provider request (core/src/client.rs
  // `reasoning_effort_for_request`), so "ultra" must never influence the provider wire — not even
  // through a raw alias. Apply the boundary before alias/clamp resolution.
  const boundary = requested === "ultra" ? "max" : requested;

  const wireMap = reasoningEffortMapFor(provider, modelId);
  if (wireMap && Object.prototype.hasOwnProperty.call(wireMap, boundary)) return wireMap[boundary];

  const supported = configuredReasoningEfforts(provider, modelId);
  const codexEffort = supported !== undefined ? clampToSupportedCodexEffort(boundary, supported) : requestToCodexEffort(boundary);
  if (!codexEffort) return undefined;

  // Belt for the odd config where the supported ladder is ultra-only and the clamp lands on it.
  const wire = codexEffort === "ultra" ? "max" : codexEffort;
  if (wireMap && Object.prototype.hasOwnProperty.call(wireMap, wire)) return wireMap[wire];
  return wire;
}
