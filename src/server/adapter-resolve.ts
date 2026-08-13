import type { OcxProviderConfig } from "../types";
import { isWirePinnedModel, MODEL_ADAPTER_OVERRIDE_ALLOWED, pinnedWireAdapter } from "../types";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import { type InboundWire, providerModelWireDefault } from "../providers/registry";
import { createRegisteredAdapter } from "../adapters/registry";

/**
 * Resolve the wire a single model should use: a hard pin first, then a configured
 * per-model override, then a registry default for a mixed-wire provider, then the provider's
 * own adapter.
 *
 * Safe to call more than once on its own output — the pin check does not look at the
 * current adapter, so a second pass cannot let an override displace a pin.
 *
 * `inbound` is the protocol the ORIGINAL client spoke. It defaults to `"responses"`
 * because the Chat and Anthropic surfaces translate into a Responses-shaped body and
 * replay through `handleResponses`; those two callers pass their real inbound so a
 * scoped registry default cannot fire for a client that never asked for that wire.
 */
export function resolveWireProtocolOverride(
  providerName: string,
  modelId: string,
  providerConfig: OcxProviderConfig,
  inbound: InboundWire = "responses",
): OcxProviderConfig {
  const pinned = pinnedWireAdapter(providerName, modelId);
  if (pinned && providerConfig.adapter !== pinned) {
    return { ...providerConfig, adapter: pinned };
  }
  const configured = providerConfig.modelAdapters?.[modelId];
  const requested = configured && MODEL_ADAPTER_OVERRIDE_ALLOWED.has(configured)
    ? configured
    : providerModelWireDefault(providerName, providerConfig, modelId, MODEL_ADAPTER_OVERRIDE_ALLOWED, inbound);
  if (requested
    && MODEL_ADAPTER_OVERRIDE_ALLOWED.has(requested)
    && requested !== providerConfig.adapter
    && !isWirePinnedModel(providerName, modelId)
    && !isCanonicalOpenAiForwardProvider(providerConfig)) {
    return { ...providerConfig, adapter: requested };
  }
  return providerConfig;
}

/** Build the provider adapter for a resolved provider config. */
export function resolveAdapter(providerConfig: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
  return createRegisteredAdapter(providerConfig, { cacheRetention });
}
