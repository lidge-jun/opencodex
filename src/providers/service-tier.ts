import type { OcxProviderConfig } from "../types";
import { MODEL_ADAPTER_OVERRIDE_ALLOWED } from "../types";
import { getProviderRegistryEntry, providerModelWireDefault, type InboundWire } from "./registry";

/** OpenAI-compatible adapters that can carry the standard `service_tier` field. */
export const SERVICE_TIER_ADAPTERS = new Set(["openai-chat", "openai-responses"]);

export type CapturedServiceTierAdapterAuthority = Readonly<Record<string, string>>;
/**
 * xAI multiplexes two transports under one provider id: an API-key mode that stays on
 * https://api.x.ai/v1 (where Priority Processing is documented) and an OAuth/CLI mode that
 * resolves to https://cli-chat-proxy.grok.com/v1 (unverified by public docs). The built-in
 * xai preset opts into chatServiceTier, but that opt-in must only arm when the effective
 * transport is the canonical API-key path (issue #1875).
 */
const XAI_CHAT_PRIORITY_PROVIDER = "xai";


const capturedAdapterAuthority = new WeakMap<object, CapturedServiceTierAdapterAuthority>();

type ServiceTierCapabilityProvider = Pick<
  OcxProviderConfig,
  "adapter" | "supportsServiceTier" | "modelSupportsServiceTier" | "modelAdapters" | "baseUrl" | "authMode" | "chatServiceTier"
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

/** Whether the Chat serializer may emit a tier for this exact model. */
export function canSerializeServiceTierForChatModel(
  provider: Pick<OcxProviderConfig, "supportsServiceTier" | "modelSupportsServiceTier" | "chatServiceTier">,
  modelId: string,
): boolean {
  const exact = exactModelValue(provider.modelSupportsServiceTier, modelId);
  if (provider.supportsServiceTier === false || exact === false) return false;
  return provider.chatServiceTier === true || exact === true;
}

/** Capture registry-owned model wire defaults before an asynchronous catalog flight begins. */
export function captureServiceTierAdapterAuthority(
  providerName: string,
  provider: Pick<OcxProviderConfig, "adapter" | "baseUrl" | "authMode">,
  registryTransportMatch: boolean,
  inbound: InboundWire = "responses",
): CapturedServiceTierAdapterAuthority {
  const authority: Record<string, string> = {};
  const defaults = registryTransportMatch
    ? getProviderRegistryEntry(providerName)?.modelWireDefaults
    : undefined;
  for (const modelId of Object.keys(defaults ?? {})) {
    const adapter = providerModelWireDefault(
      providerName,
      provider,
      modelId,
      MODEL_ADAPTER_OVERRIDE_ALLOWED,
      inbound,
    );
    if (adapter !== undefined) authority[modelId.trim().toLowerCase()] = adapter;
  }
  const frozen = Object.freeze(authority);
  capturedAdapterAuthority.set(provider, frozen);
  return frozen;
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
  const captured = capturedAdapterAuthority.get(provider);
  if (captured !== undefined) {
    return captured[modelId.trim().toLowerCase()] ?? provider.adapter;
  }
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
  return serviceTierSupportForModel(provider, modelId, providerName, inbound) === true;
}

/**
 * Return the tri-state capability after resolving the model's final wire adapter.
 * `false` means either an explicit provider/model denial or an adapter that cannot carry the
 * field; `undefined` keeps the existing conservative contract for an unclassified OpenAI wire.
 */
export function serviceTierSupportForModel(
  provider: ServiceTierCapabilityProvider,
  modelId: string,
  providerName?: string,
  inbound: InboundWire = "responses",
): boolean | undefined {
  const adapter = providerName === undefined
    ? provider.adapter
    : serviceTierAdapterForModel(providerName, provider, modelId, inbound);
  if (!SERVICE_TIER_ADAPTERS.has(adapter)) return false;
  // xAI transport gate (issue #1875): the Chat opt-in is transport-sensitive. Only the
  // canonical API-key transport is verified for Priority Processing, so it is supported
  // (true); the OAuth/CLI transport stays unadvertised and uninjected (false). An exact
  // model denial or a provider-wide supportsServiceTier: false still wins.
  if (providerName === XAI_CHAT_PRIORITY_PROVIDER && adapter === "openai-chat") {
    if (provider.supportsServiceTier === false) return false;
    if (exactModelValue(provider.modelSupportsServiceTier, modelId) === false) return false;
    return provider.authMode === "key" ? true : false;
  }
  // Treat the Chat serializer decision as authoritative so catalog metadata, routing
  // evidence, fast-mode injection, and caller-tier stripping cannot claim support that the
  // final request builder will omit. A provider-wide false and an exact false stay closed.
  if (adapter === "openai-chat" && !canSerializeServiceTierForChatModel(provider, modelId)) return false;
  return supportsServiceTierForModel(provider, modelId);
}
