import type { ModelCapabilities, OcxProviderConfig, ReasoningCapabilities } from "../types";
import { modelInList } from "../types";
import { registryEntryForProviderDestination } from "./registry";
import { legacyModelValue, mapFill, nestedMapFill } from "./resolved-model-policy-merge";

export const REASONING_CAPABILITY_FIELDS = [
  "supportsReasoning", "supportsThinkingToggle", "supportsReasoningEffort", "defaultThinkingEnabled",
] as const;

/** Case-equal model declarations merge per axis; unrelated axes retain registry defaults. */
export function mergeReasoningModelCapabilities(
  registry: Record<string, ModelCapabilities> | undefined,
  explicit: Record<string, ModelCapabilities> | undefined,
): Record<string, ModelCapabilities> | undefined {
  if (!registry && !explicit) return undefined;
  const merged: Record<string, ModelCapabilities> = {};
  const keys = new Map<string, string>();
  for (const rows of [registry, explicit]) {
    for (const [id, row] of Object.entries(rows ?? {})) {
      const key = keys.get(id.toLowerCase()) ?? id;
      keys.set(id.toLowerCase(), key);
      merged[key] = { ...merged[key], ...structuredClone(row) };
    }
  }
  return merged;
}

/** Match a declared model case-insensitively, without inheriting suffix or family aliases. */
export function declaredModelCapabilities(rows: Readonly<Record<string, ModelCapabilities>> | undefined, modelId: string): ModelCapabilities | undefined {
  return rows?.[modelId] ?? Object.entries(rows ?? {}).find(([id]) => id.toLowerCase() === modelId.toLowerCase())?.[1];
}

/** Captured-policy variant: never reads the live registry after admission. */
export function reasoningCapabilitiesFromConfig(provider: Readonly<OcxProviderConfig>, modelId: string): ReasoningCapabilities {
  if (modelInList(provider.noReasoningModels, modelId)) {
    return { supportsReasoning: false, supportsThinkingToggle: false, supportsReasoningEffort: false, defaultThinkingEnabled: false };
  }
  const declared = declaredModelCapabilities(provider.modelCapabilities, modelId);
  const result: ReasoningCapabilities = {};
  for (const field of REASONING_CAPABILITY_FIELDS) {
    if (typeof declared?.[field] === "boolean") result[field] = declared[field];
  }
  const efforts = legacyModelValue(provider.modelReasoningEfforts, modelId) ?? provider.reasoningEfforts;
  const effortMap = legacyModelValue(provider.modelReasoningEffortMap, modelId) ?? provider.reasoningEffortMap;
  const effectiveEfforts = efforts?.filter(effort => effort !== "none").map(effort => effortMap?.[effort] ?? effort);
  const strengths = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  if (result.supportsReasoningEffort === undefined && effectiveEfforts?.some(effort => strengths.includes(effort))) {
    result.supportsReasoningEffort = true;
  }
  if (result.supportsReasoning === undefined && (result.supportsThinkingToggle === true
    || result.supportsReasoningEffort === true || effectiveEfforts?.some(effort => strengths.includes(effort) || effort === "enabled" || effort === "adaptive")
    || modelInList(provider.thinkingBudgetModels, modelId))) {
    result.supportsReasoning = true;
  }
  if (result.supportsReasoning === false) {
    result.supportsThinkingToggle = false;
    result.supportsReasoningEffort = false;
    result.defaultThinkingEnabled = false;
  }
  return result;
}

/** Resolve fixed destination registry facts beneath exact operator capabilities. Unknown stays absent. */
export function resolveReasoningCapabilities(provider: OcxProviderConfig, modelId: string): ReasoningCapabilities {
  const entry = registryEntryForProviderDestination(provider);
  return reasoningCapabilitiesFromConfig({
    ...provider,
    modelCapabilities: mergeReasoningModelCapabilities(entry?.modelCapabilities, provider.modelCapabilities),
    modelReasoningEfforts: mapFill(entry?.modelReasoningEfforts, provider.modelReasoningEfforts)[0],
    reasoningEfforts: provider.reasoningEfforts ?? entry?.reasoningEfforts,
    reasoningEffortMap: mapFill(entry?.reasoningEffortMap, provider.reasoningEffortMap)[0],
    modelReasoningEffortMap: nestedMapFill(entry?.modelReasoningEffortMap, provider.modelReasoningEffortMap)[0],
    thinkingBudgetModels: [...(entry?.thinkingBudgetModels ?? []), ...(provider.thinkingBudgetModels ?? [])],
    noReasoningModels: [...(entry?.noReasoningModels ?? []), ...(provider.noReasoningModels ?? [])],
  }, modelId);
}
