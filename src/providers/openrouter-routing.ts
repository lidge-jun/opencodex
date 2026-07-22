import type { OcxProviderConfig, OpenRouterProviderRouting } from "../types";

const ROUTING_KEYS = new Set(["order", "only", "allowFallbacks"]);
const MAX_PROVIDER_SLUGS = 64;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isCanonicalOpenRouterTarget(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.origin === "https://openrouter.ai"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname.replace(/\/+$/, "") === "/api/v1";
  } catch {
    return false;
  }
}

function routingPreferenceError(value: unknown, field: string): string | null {
  if (!isPlainRecord(value)) return `${field} must be a plain object`;
  const unknown = Object.keys(value).find(key => !ROUTING_KEYS.has(key));
  if (unknown) return `${field} contains unknown field "${unknown}"`;

  for (const listField of ["order", "only"] as const) {
    const list = value[listField];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PROVIDER_SLUGS) {
      return `${field}.${listField} must contain 1-${MAX_PROVIDER_SLUGS} provider slugs`;
    }
    const seen = new Set<string>();
    for (const slug of list) {
      if (typeof slug !== "string" || !slug.trim() || slug !== slug.trim() || slug.length > 128) {
        return `${field}.${listField} must contain nonblank trimmed provider slugs up to 128 characters`;
      }
      if (seen.has(slug)) return `${field}.${listField} must not contain duplicate provider slugs`;
      seen.add(slug);
    }
  }
  if (value.allowFallbacks !== undefined && typeof value.allowFallbacks !== "boolean") {
    return `${field}.allowFallbacks must be a boolean`;
  }
  if (value.order === undefined && value.only === undefined && value.allowFallbacks === undefined) {
    return `${field} must define order, only, or allowFallbacks`;
  }
  return null;
}

export function openRouterRoutingConfigError(provider: OcxProviderConfig): string | null {
  const hasDefault = provider.openRouterRouting !== undefined;
  const hasModels = provider.modelOpenRouterRouting !== undefined;
  if (!hasDefault && !hasModels) return null;
  if (provider.adapter !== "openai-chat") {
    return "OpenRouter routing preferences require the openai-chat adapter";
  }
  if (!isCanonicalOpenRouterTarget(provider.baseUrl)) {
    return "OpenRouter routing preferences require the canonical https://openrouter.ai/api/v1 baseUrl";
  }
  if (hasDefault) {
    const error = routingPreferenceError(provider.openRouterRouting, "openRouterRouting");
    if (error) return error;
  }
  if (hasModels) {
    const routes = provider.modelOpenRouterRouting;
    if (!isPlainRecord(routes)) return "modelOpenRouterRouting must be a plain object";
    for (const [modelId, preference] of Object.entries(routes)) {
      if (!modelId.trim() || modelId !== modelId.trim()) {
        return "modelOpenRouterRouting keys must be nonblank trimmed model ids";
      }
      const error = routingPreferenceError(preference, `modelOpenRouterRouting.${modelId}`);
      if (error) return error;
    }
  }
  return null;
}

export function resolveOpenRouterRouting(
  provider: OcxProviderConfig,
  modelId: string,
): OpenRouterProviderRouting | undefined {
  if (!isCanonicalOpenRouterTarget(provider.baseUrl)) return undefined;
  const modelRoutes = provider.modelOpenRouterRouting;
  return modelRoutes && Object.hasOwn(modelRoutes, modelId)
    ? modelRoutes[modelId]
    : provider.openRouterRouting;
}

export function openRouterProviderPayload(
  preference: OpenRouterProviderRouting,
): Record<string, unknown> {
  return {
    ...(preference.order ? { order: [...preference.order] } : {}),
    ...(preference.only ? { only: [...preference.only] } : {}),
    ...(preference.allowFallbacks !== undefined ? { allow_fallbacks: preference.allowFallbacks } : {}),
  };
}
