import type { OcxProviderConfig } from "../types";
import { captureWireAdapterHardPins } from "../types";
import { isCanonicalOpenAiForwardProvider } from "./openai-tiers";
import {
  getProviderRegistryEntry,
  providerMatchesRegistryTransport,
  registryModelServiceTierCapabilityApplies,
  type InboundWire,
  type ModelWireDefault,
} from "./registry";
import {
  cloneFastWire,
  resolveFastPolicy,
  resolveProviderAuthTransport,
  type FastPolicyAuthority,
  type ResolvedFastPolicy,
} from "./fastwire";

/** OpenAI-compatible adapters that can carry the standard `service_tier` field. */
export const SERVICE_TIER_ADAPTERS = new Set(["openai-chat", "openai-responses"]);

/** @deprecated A1 evolves this snapshot into the complete FastPolicyAuthority. */
export type CapturedServiceTierAdapterAuthority = FastPolicyAuthority;

const capturedFastPolicyAuthorities = new WeakMap<object, FastPolicyAuthority>();

type ServiceTierCapabilityProvider = Pick<
  OcxProviderConfig,
  | "adapter"
  | "supportsServiceTier"
  | "modelSupportsServiceTier"
  | "modelAdapters"
  | "baseUrl"
  | "authMode"
  | "apiKeyTransport"
  | "chatServiceTier"
  | "fastWire"
>;

function cloneRegistryWireDefaults(
  defaults: Readonly<Record<string, ModelWireDefault>> | undefined,
): Readonly<Record<string, ModelWireDefault>> {
  if (!defaults) return Object.freeze({});
  const clone: Record<string, ModelWireDefault> = {};
  for (const [modelId, declaration] of Object.entries(defaults)) {
    clone[modelId.trim().toLowerCase()] = typeof declaration === "string"
      ? declaration
      : Object.freeze({
          wire: declaration.wire,
          inbound: Object.freeze([...declaration.inbound]),
          ...(declaration.authModes
            ? { authModes: Object.freeze([...declaration.authModes]) }
            : {}),
          ...(declaration.forwardCallerServiceTier !== undefined
            ? { forwardCallerServiceTier: declaration.forwardCallerServiceTier }
            : {}),
        });
  }
  return Object.freeze(clone);
}

/**
 * Capture every registry-owned input before an asynchronous catalog flight begins.
 * The resolver itself is pure and never reads the live provider registry.
 */
function buildFastPolicyAuthority(
  providerName: string,
  provider: ServiceTierCapabilityProvider,
  registryTransportMatch: boolean,
  capabilityProvider: ServiceTierCapabilityProvider = provider,
): FastPolicyAuthority {
  const registry = registryTransportMatch ? getProviderRegistryEntry(providerName) : undefined;
  const registryModelCapabilities = registry
    && registryModelServiceTierCapabilityApplies(registry, capabilityProvider)
    ? registry.modelSupportsServiceTier
    : undefined;
  const providerCapability = capabilityProvider.supportsServiceTier ?? registry?.supportsServiceTier;
  const authority: FastPolicyAuthority = Object.freeze({
    providerAdapter: provider.adapter,
    providerAuthMode: provider.authMode ?? registry?.authKind ?? "key",
    fastWireDeclaration: cloneFastWire(
      provider.fastWire !== undefined ? provider.fastWire : registry?.fastWire,
      { freeze: true },
    ),
    modelWireOverrideAllowed: !isCanonicalOpenAiForwardProvider(provider as OcxProviderConfig),
    authTransport: resolveProviderAuthTransport(
      provider.adapter,
      provider.authMode ?? registry?.authKind ?? "key",
      provider.apiKeyTransport,
    ),
    capability: Object.freeze({
      ...(providerCapability !== undefined ? { provider: providerCapability } : {}),
      models: Object.freeze({
        ...(registryModelCapabilities ?? {}),
        ...(capabilityProvider.modelSupportsServiceTier ?? {}),
      }),
      ...(provider.chatServiceTier !== undefined ? { chatServiceTier: provider.chatServiceTier } : {}),
    }),
    modelAdapters: Object.freeze({ ...(provider.modelAdapters ?? {}) }),
    hardPins: captureWireAdapterHardPins(providerName),
    registryWireDefaults: cloneRegistryWireDefaults(registry?.modelWireDefaults),
  });
  return authority;
}

export function captureFastPolicyAuthority(
  providerName: string,
  provider: ServiceTierCapabilityProvider,
  registryTransportMatch: boolean,
  capabilityProvider: ServiceTierCapabilityProvider = provider,
): FastPolicyAuthority {
  const authority = buildFastPolicyAuthority(
    providerName,
    provider,
    registryTransportMatch,
    capabilityProvider,
  );
  if (Object.isFrozen(provider)) capturedFastPolicyAuthorities.set(provider, authority);
  return authority;
}

/** @deprecated Use captureFastPolicyAuthority. The legacy inbound argument is now snapshot data. */
export function captureServiceTierAdapterAuthority(
  providerName: string,
  provider: ServiceTierCapabilityProvider,
  registryTransportMatch: boolean,
  _inbound: InboundWire = "responses",
): FastPolicyAuthority {
  return captureFastPolicyAuthority(providerName, provider, registryTransportMatch);
}

function authorityForProvider(
  provider: ServiceTierCapabilityProvider,
  providerName?: string,
  capabilityProvider?: ServiceTierCapabilityProvider,
): FastPolicyAuthority {
  // Preserve the legacy no-name short circuit: serviceTierSupportForModel() used the
  // provider adapter directly when no provider identity was available, so no configured
  // override, hard pin, or registry default may participate on this path in A1.
  if (providerName === undefined) {
    const authority = buildFastPolicyAuthority("", provider, false, capabilityProvider ?? provider);
    return Object.freeze({
      ...authority,
      modelAdapters: Object.freeze({}),
      hardPins: Object.freeze({}),
      registryWireDefaults: Object.freeze({}),
    });
  }
  const captured = capabilityProvider === undefined && Object.isFrozen(provider)
    ? capturedFastPolicyAuthorities.get(provider)
    : undefined;
  if (captured) return captured;
  const registryTransportMatch = providerMatchesRegistryTransport(providerName, provider);
  const authority = buildFastPolicyAuthority(
    providerName,
    provider,
    registryTransportMatch,
    capabilityProvider ?? provider,
  );
  // Frozen provider snapshots cannot drift, so repeated catalog/runtime projections may safely
  // reuse the registry lookup and detached declaration maps. Mutable configs still rebuild.
  if (Object.isFrozen(provider)) capturedFastPolicyAuthorities.set(provider, authority);
  return authority;
}

/** Resolve the pure Fast policy for a provider/model pair. */
export function fastPolicyForModel(
  provider: ServiceTierCapabilityProvider,
  modelId: string,
  providerName?: string,
  inbound: InboundWire = "responses",
  capabilityProvider?: ServiceTierCapabilityProvider,
): ResolvedFastPolicy {
  return resolveFastPolicy(
    authorityForProvider(provider, providerName, capabilityProvider),
    modelId,
    inbound,
  );
}

/**
 * Resolve the declared provider/model capability without applying wire availability.
 * Kept as a public compatibility helper for callers that need the pure tri-state.
 */
export function supportsServiceTierForModel(
  provider: Pick<OcxProviderConfig, "supportsServiceTier" | "modelSupportsServiceTier">,
  modelId: string,
): boolean | undefined {
  const authority: FastPolicyAuthority = {
    providerAdapter: "openai-responses",
    fastWireDeclaration: undefined,
    modelWireOverrideAllowed: true,
    authTransport: "authorization_bearer",
    capability: {
      ...(provider.supportsServiceTier !== undefined ? { provider: provider.supportsServiceTier } : {}),
      models: provider.modelSupportsServiceTier ?? {},
    },
    modelAdapters: {},
    hardPins: {},
    registryWireDefaults: {},
  };
  return resolveFastPolicy(authority, modelId).capability;
}

/** Whether a Chat route may forward an arbitrary caller tier rather than canonical Fast. */
export function canForwardForeignServiceTierForChatModel(
  provider: Pick<OcxProviderConfig, "supportsServiceTier" | "modelSupportsServiceTier" | "chatServiceTier">,
  modelId: string,
): boolean {
  const capability = supportsServiceTierForModel(provider, modelId);
  return capability !== false && provider.chatServiceTier === true;
}

/** Final adapter selected by the Fast policy's four-level wire resolver. */
export function serviceTierAdapterForModel(
  providerName: string,
  provider: ServiceTierCapabilityProvider,
  modelId: string,
  inbound: InboundWire = "responses",
): string {
  return fastPolicyForModel(provider, modelId, providerName, inbound).adapter;
}

/** Whether the final provider/model pair can publish/send OpenAI service tiers. */
export function canForwardServiceTierForModel(
  provider: ServiceTierCapabilityProvider,
  modelId: string,
  providerName?: string,
  inbound: InboundWire = "responses",
): boolean {
  return serviceTierSupportForModel(provider, modelId, providerName, inbound) === true;
}

/**
 * Compatibility projection for catalog, routing, and fingerprint consumers. The new
 * resolver carries richer eligibility internally while preserving the old tri-state bytes.
 */
export function serviceTierSupportForModel(
  provider: ServiceTierCapabilityProvider,
  modelId: string,
  providerName?: string,
  inbound: InboundWire = "responses",
): boolean | undefined {
  const policy = fastPolicyForModel(provider, modelId, providerName, inbound);
  return serviceTierSupportFromPolicy(policy);
}

/** Compatibility projection shared by catalog, routing, and request logging. */
export function serviceTierSupportFromPolicy(
  policy: Pick<ResolvedFastPolicy, "eligibility" | "adapter" | "forwardCallerTier">,
): boolean | undefined {
  if (policy.eligibility === "eligible") return true;
  if (policy.eligibility === "unclassified") {
    // An unclassified route that cannot forward a caller tier has definitive negative
    // evidence even when its adapter can normally serialize service_tier. This covers both
    // Chat routes without chatServiceTier and a registry default that explicitly closes a
    // subscription gateway. Generic unclassified Responses routes still project unknown.
    if (!policy.forwardCallerTier) return false;
    return undefined;
  }
  return false;
}
