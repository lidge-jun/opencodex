import type { OcxProviderConfig, VercelGatewayRouting } from "../types";
import { sanitizeLogMetadataString } from "../lib/redact";

const ROUTING_KEYS = new Set(["order", "only", "sort"]);
const SORT_VALUES = new Set(["cost", "ttft", "tps"]);
const MAX_PROVIDER_SLUGS = 64;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isCanonicalVercelGatewayTarget(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.origin === "https://ai-gateway.vercel.sh"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname.replace(/\/+$/, "") === "/v1";
  } catch {
    return false;
  }
}

function routingPreferenceError(value: unknown, field: string): string | null {
  if (!isPlainRecord(value)) return `${field} must be a plain object`;
  const unknown = Object.keys(value).find(key => !ROUTING_KEYS.has(key));
  if (unknown) return `${field} contains unknown field "${sanitizeLogMetadataString(unknown)}"`;

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
  if (value.sort !== undefined && (typeof value.sort !== "string" || !SORT_VALUES.has(value.sort))) {
    return `${field}.sort must be "cost", "ttft", or "tps"`;
  }
  if (value.order === undefined && value.only === undefined && value.sort === undefined) {
    return `${field} must define order, only, or sort`;
  }
  return null;
}

export function vercelGatewayRoutingConfigError(provider: OcxProviderConfig): string | null {
  const hasDefault = provider.vercelGatewayRouting !== undefined;
  const hasModels = provider.modelVercelGatewayRouting !== undefined;
  if (!hasDefault && !hasModels) return null;
  if (provider.adapter !== "openai-chat") {
    return "Vercel AI Gateway routing preferences require the openai-chat adapter";
  }
  if (!isCanonicalVercelGatewayTarget(provider.baseUrl)) {
    return "Vercel AI Gateway routing preferences require the canonical https://ai-gateway.vercel.sh/v1 baseUrl";
  }
  if (hasDefault) {
    const error = routingPreferenceError(provider.vercelGatewayRouting, "vercelGatewayRouting");
    if (error) return error;
  }
  if (hasModels) {
    const routes = provider.modelVercelGatewayRouting;
    if (!isPlainRecord(routes)) return "modelVercelGatewayRouting must be a plain object";
    for (const [modelId, preference] of Object.entries(routes)) {
      if (!modelId.trim() || modelId !== modelId.trim()) {
        return "modelVercelGatewayRouting keys must be nonblank trimmed model ids";
      }
      const error = routingPreferenceError(preference, `modelVercelGatewayRouting.${sanitizeLogMetadataString(modelId)}`);
      if (error) return error;
    }
  }
  return null;
}

export function resolveVercelGatewayRouting(
  provider: OcxProviderConfig,
  modelId: string,
): VercelGatewayRouting | undefined {
  if (!isCanonicalVercelGatewayTarget(provider.baseUrl)) return undefined;
  const modelRoutes = provider.modelVercelGatewayRouting;
  return modelRoutes && Object.hasOwn(modelRoutes, modelId)
    ? modelRoutes[modelId]
    : provider.vercelGatewayRouting;
}

export function vercelGatewayProviderPayload(
  preference: VercelGatewayRouting,
): Record<string, unknown> {
  return {
    ...(preference.order ? { order: [...preference.order] } : {}),
    ...(preference.only ? { only: [...preference.only] } : {}),
    ...(preference.sort ? { sort: preference.sort } : {}),
  };
}
