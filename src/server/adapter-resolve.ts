import { createAnthropicAdapter } from "../adapters/anthropic";
import { createAzureAdapter } from "../adapters/azure";
import { createCursorAdapter } from "../adapters/cursor";
import { createGoogleAdapter } from "../adapters/google";
import { createKiroAdapter } from "../adapters/kiro";
import { createMimoFreeAdapter } from "../adapters/mimo-free";
import { createOpenAIChatAdapter } from "../adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../adapters/openai-responses";
import type { OcxProviderConfig } from "../types";
import { isWirePinnedModel, MODEL_ADAPTER_OVERRIDE_ALLOWED, pinnedWireAdapter } from "../types";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";

/**
 * Resolve the wire a single model should use: a hard pin first, then a configured
 * per-model override, then the provider's own adapter.
 *
 * Safe to call more than once on its own output — the pin check does not look at the
 * current adapter, so a second pass cannot let an override displace a pin.
 */
export function resolveWireProtocolOverride(providerName: string, modelId: string, providerConfig: OcxProviderConfig): OcxProviderConfig {
  const pinned = pinnedWireAdapter(providerName, modelId);
  if (pinned && providerConfig.adapter !== pinned) {
    return { ...providerConfig, adapter: pinned };
  }
  // Re-check the allow-list here, not just in the config validator: the file may have
  // been hand-edited, or written by a build that allowed more values.
  const requested = providerConfig.modelAdapters?.[modelId];
  if (requested
    && MODEL_ADAPTER_OVERRIDE_ALLOWED.has(requested)
    && requested !== providerConfig.adapter
    && !isWirePinnedModel(providerName, modelId)
    // A forward provider hands the caller's own credential upstream; the chat adapter
    // only ever sends provider.apiKey, so switching wires here would drop the auth.
    && !isCanonicalOpenAiForwardProvider(providerConfig)) {
    return { ...providerConfig, adapter: requested };
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
