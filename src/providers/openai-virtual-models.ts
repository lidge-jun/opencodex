import { PROVIDER_REGISTRY } from "./registry";
import { OPENAI_API_PROVIDER_ID } from "./openai-tiers";
import type { OcxParsedRequest } from "../types";
import type { RouteResult } from "../router";
import type { RequestLogContext } from "../server/request-log";

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

export function applyOpenAiVirtualModel(
  parsed: OcxParsedRequest,
  route: RouteResult,
  logCtx: RequestLogContext,
): OpenAiVirtualModelResolution | undefined {
  const selectedModelId = logCtx.model && logCtx.model !== route.modelId ? logCtx.model : route.modelId;
  const resolution = resolveOpenAiVirtualModel(route.providerName, selectedModelId);
  if (!resolution) return undefined;

  logCtx.model = resolution.selectedModelId;
  logCtx.resolvedModel = resolution.wireModelId;
  route.modelId = resolution.wireModelId;
  parsed.modelId = resolution.wireModelId;

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
