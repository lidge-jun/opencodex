import { registryEntryForProviderDestination } from "../providers/registry";
import { resolveReasoningCapabilities } from "../providers/reasoning-capabilities";
import { modelInList, type OcxProviderConfig } from "../types";

/** A thinking toggle is serialized only on a provider-declared wire. */
export function declaresThinkingToggleWire(provider: OcxProviderConfig, modelId: string): boolean {
  return modelInList(provider.thinkingToggleModels, modelId)
    || modelInList(registryEntryForProviderDestination(provider)?.thinkingToggleModels, modelId);
}

/** Explicitly unavailable controls constrain both translated and native requests. */
export function reasoningControlsAreUnsupported(provider: OcxProviderConfig, modelId: string): boolean {
  const capabilities = resolveReasoningCapabilities(provider, modelId);
  return capabilities.supportsReasoning === false
    || (capabilities.supportsThinkingToggle === false && capabilities.supportsReasoningEffort === false);
}
