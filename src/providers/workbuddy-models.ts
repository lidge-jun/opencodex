import { isValidModelDiscoveryModelId } from "./model-discovery-limits";
import type { ProviderModelItemsResult, ProviderModelsApiItem } from "./model-discovery";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The product catalog contains non-chat models too; only the CLI agent's roster is routable. */
export function extractWorkBuddyModels(value: unknown, limit: number): ProviderModelItemsResult {
  const envelope = record(value), data = record(envelope.data);
  if ((envelope.code !== 0 && envelope.code !== "0") || !Array.isArray(data.agents) || !Array.isArray(data.models)) return { ok: false, reason: "invalid_shape" };
  if (data.models.length > limit || data.agents.length > limit) return { ok: false, reason: "too_many_models" };
  const agent = data.agents.map(record).find(a => a.name === "cli");
  if (!Array.isArray(agent?.models)) return { ok: false, reason: "invalid_shape" };
  if (agent.models.length > limit) return { ok: false, reason: "too_many_models" };
  const definitions = new Map(data.models.map(raw => { const row = record(raw); return [row.id, row] as const; }));
  const items: ProviderModelsApiItem[] = [], seen = new Set<string>();
  for (const id of agent.models) {
    if (!isValidModelDiscoveryModelId(id)) return { ok: false, reason: "invalid_shape" };
    if (seen.has(id)) continue;
    seen.add(id);
    const row = definitions.get(id) ?? {}, reasoning = record(row.reasoning);
    const rawEfforts = Array.isArray(reasoning.supportedEfforts) ? reasoning.supportedEfforts
      : row.supportsReasoning === true ? ["low", "high", "max"] : [];
    const efforts = rawEfforts.filter(e => typeof e === "string" && ["low", "medium", "high", "xhigh", "max"].includes(e));
    if (efforts.length && row.onlyReasoning !== true && reasoning.canDisableThinking !== false) efforts.unshift("none");
    const positive = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined;
    items.push({
      id, ...(typeof row.name === "string" && row.name.length <= 256 ? { name: row.name } : {}),
      context_length: positive(row.maxInputTokens), max_input_tokens: positive(row.maxInputTokens),
      max_output_tokens: positive(row.maxOutputTokens), reasoning_efforts: efforts,
      // WorkBuddy AI filters images from GLM requests despite advertising supportsImages.
      input_modalities: row.supportsImages === true && !id.startsWith("glm-") ? ["text", "image"] : ["text"],
    });
  }
  return { ok: true, items, rawCount: agent.models.length };
}
