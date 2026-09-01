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

/**
 * Sentinel wire value in reasoningEffortMap / modelReasoningEffortMap to explicitly
 * omit the reasoning_effort field from the upstream wire request (issue #2356).
 */
export const REASONING_EFFORT_OMIT_SENTINEL = "__omit__";

export function isReasoningEffortOmitted(wireEffort: string | undefined): boolean {
  return wireEffort === REASONING_EFFORT_OMIT_SENTINEL;
}

/** True when `effort` is a member of the Codex reasoning ladder (low..ultra). */
export function isCodexReasoningEffort(effort: string): boolean {
  return CODEX_REASONING_SET.has(effort);
}

/**
 * True for ladder members plus the `none`/`minimal` sentinels. Both are valid declared
 * efforts (OpenAI accepts `minimal`; Codex validates `none` against
 * `supported_reasoning_levels` for no-reasoning subagent spawns, #883/#962) but are NOT
 * part of the low..ultra ladder: they never appear in default ladders, ranks, or clamps
 * (`minimal` is mapped to `low` on the wire by requestToCodexEffort).
 */
export function isDeclaredReasoningEffort(effort: string): boolean {
  return effort === "none" || effort === "minimal" || CODEX_REASONING_SET.has(effort);
}

/**
 * Reorder any declared subset (low..ultra, plus the optional `none`/`minimal` sentinels
 * first, in that order) into canonical order and drop duplicates. Catalog
 * `supported_reasoning_levels` follow the input order and the fallback default picks the
 * first entry, so a caller-chosen order would otherwise leak into the catalog.
 */
export function canonicalizeReasoningEfforts(values: readonly string[]): string[] {
  const seen = new Set(values);
  const ordered = CODEX_REASONING_ORDER.filter(effort => seen.has(effort));
  const sentinels = ["none", "minimal"].filter(effort => seen.has(effort));
  return [...sentinels, ...ordered];
}

/**
 * Reasoning ladder accepted for the OpenAI vision sidecar. `ultra` is deliberately excluded:
 * the vision describer is a single helper call, and `ultra` would be collapsed to `max` by the
 * upstream client boundary anyway.
 */
export const VISION_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type VisionReasoningEffort = typeof VISION_REASONING_EFFORTS[number];

/** True when `effort` is one of the vision sidecar's supported Responses reasoning levels. */
export function isVisionReasoningEffort(effort: unknown): effort is VisionReasoningEffort {
  return typeof effort === "string" && (VISION_REASONING_EFFORTS as readonly string[]).includes(effort);
}

/**
 * Normalize a persisted/configured vision reasoning value. Invalid values (hand-edited config,
 * stale files) degrade to `undefined` so the caller falls back to the documented default instead
 * of forwarding an upstream-rejected effort.
 */
export function sanitizeVisionReasoning(effort: unknown): VisionReasoningEffort | undefined {
  return isVisionReasoningEffort(effort) ? effort : undefined;
}

/** Position of `effort` in the Codex ladder (low=0 .. ultra=5), or -1 when not a ladder member. */
export function codexEffortRank(effort: string): number {
  return CODEX_REASONING_ORDER.indexOf(effort);
}

/**
 * Resolve a requested effort against the rungs a target actually supports, never
 * raising above the request.
 *
 * Returns the request itself when supported, otherwise the highest supported rung
 * at or below it, otherwise the lowest supported rung, and `undefined` when the
 * supported set contains no rankable rung at all (including the empty ladder, which
 * is how a no-reasoning model is expressed).
 *
 * This lives here rather than beside its first caller because two very different
 * planes need the same answer: the catalog advertises a combo's default effort, and
 * the request path injects one. When they disagreed, the catalog promised `max` and
 * the runtime silently sent nothing, so the provider default applied instead (#3108).
 * `reasoning-effort.ts` is a leaf — its only import is `./types` — so the request
 * path can share this without pulling the catalog plane along.
 */
export function resolveEffortAtOrBelow(
  requested: string | null | undefined,
  supported: readonly string[],
): string | undefined {
  if (!requested) return undefined;
  if (supported.includes(requested)) return requested;
  const requestedRank = codexEffortRank(requested);
  const ranked = supported
    .map(effort => ({ effort, rank: codexEffortRank(effort) }))
    .filter(item => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  if (ranked.length === 0) return undefined;
  const atOrBelow = ranked.filter(item => item.rank <= requestedRank);
  return atOrBelow.at(-1)?.effort ?? ranked[0]!.effort;
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
    // `none`/`minimal` are valid declared sentinels, kept and sorted first (rank -1); they
    // never appear in the default ladder.
    if ((effort !== "none" && effort !== "minimal" && !CODEX_REASONING_SET.has(effort)) || seen.has(effort)) continue;
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
  if (wireMap && Object.prototype.hasOwnProperty.call(wireMap, boundary)) {
    const mapped = wireMap[boundary];
    return mapped === REASONING_EFFORT_OMIT_SENTINEL ? undefined : mapped;
  }

  const supported = configuredReasoningEfforts(provider, modelId);
  const codexEffort = supported !== undefined ? clampToSupportedCodexEffort(boundary, supported) : requestToCodexEffort(boundary);
  if (!codexEffort) return undefined;

  // Belt for the odd config where the supported ladder is ultra-only and the clamp lands on it.
  const wire = codexEffort === "ultra" ? "max" : codexEffort;
  if (wireMap && Object.prototype.hasOwnProperty.call(wireMap, wire)) {
    const mapped = wireMap[wire];
    return mapped === REASONING_EFFORT_OMIT_SENTINEL ? undefined : mapped;
  }
  if (wire === REASONING_EFFORT_OMIT_SENTINEL) return undefined;
  return wire;
}
