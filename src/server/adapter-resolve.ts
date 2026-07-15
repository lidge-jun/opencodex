import { createAnthropicAdapter } from "../adapters/anthropic";
import { createAzureAdapter } from "../adapters/azure";
import { createCursorAdapter } from "../adapters/cursor";
import { createGoogleAdapter } from "../adapters/google";
import { createKiroAdapter } from "../adapters/kiro";
import { createMimoFreeAdapter } from "../adapters/mimo-free";
import { createOpenAIChatAdapter } from "../adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../adapters/openai-responses";
import type { OcxProviderConfig } from "../types";

/** Providers whose listed model ids must be driven over the Anthropic wire even if the provider's
 *  configured adapter is something else (the upstream only speaks Anthropic for these models). */
const ANTHROPIC_WIRE_MODELS: Record<string, Set<string>> = {
  "opencode-go": new Set(["minimax-m2.5", "minimax-m2.7", "minimax-m3"]),
};

/** Return a provider config whose adapter is forced to "anthropic" when the model id is wire-pinned. */
export function resolveWireProtocolOverride(providerName: string, modelId: string, providerConfig: OcxProviderConfig): OcxProviderConfig {
  const overrideSet = ANTHROPIC_WIRE_MODELS[providerName];
  if (overrideSet?.has(modelId) && providerConfig.adapter !== "anthropic") {
    return { ...providerConfig, adapter: "anthropic" };
  }
  return providerConfig;
}

/** Build the provider adapter for a resolved provider config. */
export function resolveAdapter(providerConfig: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
  switch (providerConfig.adapter) {
    case "openai-chat":
      return createOpenAIChatAdapter(providerConfig);
    case "anthropic":
      return createAnthropicAdapter(providerConfig, cacheRetention);
    case "openai-responses":
      return createResponsesPassthroughAdapter(providerConfig);
    case "google":
      return createGoogleAdapter(providerConfig);
    case "kiro":
      return createKiroAdapter(providerConfig);
    case "azure":
    case "azure-openai":
      return createAzureAdapter(providerConfig);
    case "cursor":
      return createCursorAdapter(providerConfig);
    case "mimo-free":
      return createMimoFreeAdapter(providerConfig);
    default:
      throw new Error(`Unknown adapter: ${providerConfig.adapter}`);
  }
}
