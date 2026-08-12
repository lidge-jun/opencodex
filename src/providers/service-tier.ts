import type { OcxProviderConfig } from "../types";
import { MODEL_ADAPTER_OVERRIDE_ALLOWED } from "../types";
import { providerModelWireDefault, type InboundWire } from "./registry";

/** OpenAI-compatible adapters that can carry the standard `service_tier` field. */
export const SERVICE_TIER_ADAPTERS = new Set(["openai-chat", "openai-responses"]);

type ServiceTierCapabilityProvider = Pick<
  OcxProviderConfig,
  "adapter" | "supportsServiceTier" | "modelSupportsServiceTier" | "modelAdapters" | "baseUrl" | "authMode"
>;

/**
 * Read a model map by exact model identity. Service-tier capability is deliberately
 * stricter than the older model metadata maps: a family key or a colon-qualified
 * fallback must not silently advertise Fast for a sibling model that was never verified.
 * A case-insensitive exact match keeps hand-edited ids consistent with the other maps
 * without widening the model scope.
 */
function exactModelValue<T>(
  record: Record<string, T> | undefined,
  modelId: string,
): T | undefined {
  if (!record) return undefined;
  if (Object.prototype.hasOwnProperty.call(record, modelId)) return record[modelId];
  const folded = modelId.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === folded) return value;
  }
  return undefined;
}

/**
 * Resolve the declared provider/model capability. An explicit provider-level false is a
 * fail-closed boundary and cannot be reopened by a model map. Otherwise an exact model
 * declaration wins over the provider default, including an explicit false. The resolver is
 * provider-local: the caller must first resolve the final provider, so identical bare model ids
 * on two providers cannot share capability state.
 */
export function supportsServiceTierForModel(
  provider: Pick<OcxProviderConfig, "supportsServiceTier" | "modelSupportsServiceTier">,
  modelId: string,
): boolean | undefined {
  if (provider.supportsServiceTier === false) return false;
  return exactModelValue(provider.modelSupportsServiceTier, modelId)
    ?? provider.supportsServiceTier;
}

/** Resolve an explicit model wire override for catalog-time capability projection. */
export function serviceTierAdapterForModel(
  providerName: string,
  provider: Pick<OcxProviderConfig, "adapter" | "baseUrl" | "authMode" | "modelAdapters">,
  modelId: string,
  inbound: InboundWire = "responses",
): string {
  // Keep this lookup identical to resolveWireProtocolOverride(): configured model-adapter
  // entries are exact-case keys, while registry defaults intentionally normalize ids there.
  const configured = provider.modelAdapters?.[modelId];
  if (configured !== undefined && MODEL_ADAPTER_OVERRIDE_ALLOWED.has(configured)) return configured;
  return providerModelWireDefault(
    providerName,
    provider,
    modelId,
    MODEL_ADAPTER_OVERRIDE_ALLOWED,
    inbound,
  ) ?? provider.adapter;
}

/** Whether the final provider/model pair can actually publish/send OpenAI service tiers. */
export function canForwardServiceTierForModel(
  provider: ServiceTierCapabilityProvider,
  modelId: string,
  providerName?: string,
  inbound: InboundWire = "responses",
): boolean {
  const adapter = providerName === undefined
    ? provider.adapter
    : serviceTierAdapterForModel(providerName, provider, modelId, inbound);
  return SERVICE_TIER_ADAPTERS.has(adapter)
    && supportsServiceTierForModel(provider, modelId) === true;
}
