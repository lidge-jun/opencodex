import type { ModelCapabilities, OcxProviderConfig, ReasoningCapabilities } from "../types";
import { modelInList } from "../types";
import { registryEntryForProviderDestination } from "./registry";
import { legacyModelValue, mapFill, nestedMapFill } from "./resolved-model-policy-merge";

export const REASONING_CAPABILITY_FIELDS = [
  "supportsReasoning", "supportsThinkingToggle", "supportsReasoningEffort", "defaultThinkingEnabled",
] as const;

/** Exact model declarations merge per axis; unrelated operator axes retain registry defaults. */
export function mergeReasoningModelCapabilities(
  registry: Record<string, ModelCapabilities> | undefined,
  explicit: Record<string, ModelCapabilities> | undefined,
): Record<string, ModelCapabilities> | undefined {
  if (!registry && !explicit) return undefined;
  const merged: Record<string, ModelCapabilities> = structuredClone(registry ?? {});
  for (const [id, row] of Object.entries(explicit ?? {})) merged[id] = { ...merged[id], ...structuredClone(row) };
  return merged;
}

/** Captured-policy variant: never reads the live registry after admission. */
export function reasoningCapabilitiesFromConfig(provider: Readonly<OcxProviderConfig>, modelId: string): ReasoningCapabilities {
  if (modelInList(provider.noReasoningModels, modelId)) {
    return { supportsReasoning: false, supportsThinkingToggle: false, supportsReasoningEffort: false, defaultThinkingEnabled: false };
  }
  const declared = provider.modelCapabilities?.[modelId];
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
