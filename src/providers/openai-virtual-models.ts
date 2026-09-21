import { PROVIDER_REGISTRY } from "./registry";
import { OPENAI_API_PROVIDER_ID } from "./openai-tiers";
import type { OcxParsedRequest } from "../types";
import type { RouteResult } from "../router";
import type { RequestLogContext } from "../server/request-log";
import type { InboundWire } from "./registry/types";
import { providerMatchesRegistryTransportWithStaticGuards } from "./static-model-discovery";
import { resolveModelPolicy } from "./resolved-model-policy";

export interface OpenAiVirtualModelResolution {
  selectedModelId: string;
  wireModelId: string;
  reasoningMode: "pro";
}

export class InvalidOpenAiVirtualModelRegistryError extends Error {
  constructor(selectedModelId: string) {
    super(`Invalid OpenAI virtual model registry definition: ${selectedModelId}`);
    this.name = "InvalidOpenAiVirtualModelRegistryError";
  }
}

export function validateOpenAiVirtualModelDefinition(
  selectedModelId: string,
  definition: unknown,
): OpenAiVirtualModelResolution {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new InvalidOpenAiVirtualModelRegistryError(selectedModelId);
  }
  const raw = definition as { wireModelId?: unknown; reasoningMode?: unknown };
  if (
    typeof raw.wireModelId !== "string"
    || raw.wireModelId.trim() !== raw.wireModelId
    || raw.wireModelId.length === 0
    || raw.wireModelId.includes("/")
    || raw.wireModelId === selectedModelId
    || raw.reasoningMode !== "pro"
  ) {
    throw new InvalidOpenAiVirtualModelRegistryError(selectedModelId);
  }
  return { selectedModelId, wireModelId: raw.wireModelId, reasoningMode: "pro" };
}

export function resolveOpenAiVirtualModel(
  providerName: string,
  selectedModelId: string,
): OpenAiVirtualModelResolution | undefined {
  if (providerName !== OPENAI_API_PROVIDER_ID) return undefined;
  const entry = PROVIDER_REGISTRY.find(row => row.id === OPENAI_API_PROVIDER_ID);
  if (!entry?.virtualModels || !Object.hasOwn(entry.virtualModels, selectedModelId)) return undefined;
  const definition = entry.virtualModels[selectedModelId];
  return validateOpenAiVirtualModelDefinition(selectedModelId, definition);
}

export function captureOpenAiVirtualWirePolicy(
  route: RouteResult,
  resolution: OpenAiVirtualModelResolution,
  inboundWire: InboundWire = "responses",
): void {
  // applyOpenAiVirtualModel is also a public mutation helper with older focused callers that
  // construct only providerName/modelId/provider. Production RouteResult builders always capture
  // staticPolicy; a legacy partial shape has no authority to recapture and keeps the old rewrite.
  if (!route.staticPolicy) return;
  const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === route.providerName);
  route.staticPolicy = resolveModelPolicy({
    providerName: route.providerName,
    modelId: resolution.wireModelId,
    provider: route.provider,
    registryEntry: entry,
    transportMatchedRegistry: !!entry
      && providerMatchesRegistryTransportWithStaticGuards(route.providerName, route.provider),
    inboundWire,
    modelCapabilities: route.provider.modelCapabilities?.[resolution.wireModelId],
    ...(route.provider.authMode ? { effectiveAuth: { authMode: route.provider.authMode } } : {}),
    ...(route.staticPolicy?.effectiveAlias !== undefined
      ? { effectiveAlias: route.staticPolicy.effectiveAlias }
      : {}),
  });
}

export function applyOpenAiVirtualModel(
  parsed: OcxParsedRequest,
  route: RouteResult,
  logCtx: RequestLogContext,
  inboundWire: InboundWire = "responses",
): OpenAiVirtualModelResolution | undefined {
  // Routing has already removed the provider namespace and resolved model aliases. Never use
  // logCtx.model for identity: it is reporting state and can still contain a namespaced selector.
  const resolution = resolveOpenAiVirtualModel(route.providerName, route.modelId)
    ?? (() => {
      // Preserve the public helper's idempotent second-call contract from its own mutation
      // provenance, without promoting reporting state back into routing authority.
      const selected = parsed._openAiVirtualSelectedModelId;
      if (typeof selected !== "string") return undefined;
      const remembered = resolveOpenAiVirtualModel(route.providerName, selected);
      return remembered?.wireModelId === route.modelId ? remembered : undefined;
    })();
  if (!resolution) return undefined;

  logCtx.model = resolution.selectedModelId;
  logCtx.resolvedModel = resolution.wireModelId;
  route.modelId = resolution.wireModelId;
  captureOpenAiVirtualWirePolicy(route, resolution, inboundWire);
  parsed.modelId = resolution.wireModelId;
  parsed._openAiVirtualSelectedModelId = resolution.selectedModelId;

  if (parsed._rawBody && typeof parsed._rawBody === "object" && !Array.isArray(parsed._rawBody)) {
    const raw = parsed._rawBody as Record<string, unknown>;
    raw.model = resolution.wireModelId;
    const existing = raw.reasoning;
    raw.reasoning = existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>), mode: resolution.reasoningMode }
      : { mode: resolution.reasoningMode };
  }
  return resolution;
}

export function resolveOpenAiCompactModel(
  providerName: string,
  selectedModelId: string,
): OpenAiVirtualModelResolution | undefined {
  return resolveOpenAiVirtualModel(providerName, selectedModelId);
}
