import type { OcxProviderConfig } from "../types";
import { isBuiltinAnthropicInstanceRow } from "../providers/anthropic-instance";
import { resolveProviderModelDiscoveryUrl } from "../providers/model-discovery";
import { resolveProviderTransport } from "../providers/xai-transport";

/** Discovery owns its configured row (a frozen capture for catalog gathers), not live config. */
export function mayResolveModelsOAuth(name: string, provider: OcxProviderConfig | undefined): boolean {
  return name !== "anthropic2" || (provider !== undefined && provider.disabled !== true
    && isBuiltinAnthropicInstanceRow(name, provider));
}

/** Derive authority from configured transport/discovery policy, never from the outgoing request. */
export function captureModelsOAuthTarget(name: string, provider: OcxProviderConfig | undefined): string | undefined {
  if (name !== "anthropic2" || !mayResolveModelsOAuth(name, provider) || !provider) return undefined;
  try {
    const effective = resolveProviderTransport(name, provider);
    const base = effective.baseUrl.replace(/\/v1\/?$/, "");
    const target = new URL(resolveProviderModelDiscoveryUrl(name, provider, effective.baseUrl, `${base}/v1/models?limit=1000`));
    return !target.username && !target.password && !target.hash ? target.href : undefined;
  } catch { return undefined; }
}

export function modelsOAuthTargetMatches(name: string, provider: OcxProviderConfig | undefined, target: string | undefined): boolean {
  return name !== "anthropic2" || (target !== undefined && captureModelsOAuthTarget(name, provider) === target);
}

/** A supplied snapshot cannot authorize sending Pool 2's bearer to a custom destination. */
export function guardModelsOAuthRequest<T extends { url: string; headers: Record<string, string> }>(
  name: string,
  provider: OcxProviderConfig,
  request: T,
  authorizedTarget = captureModelsOAuthTarget(name, provider),
): T {
  if (name !== "anthropic2" || provider.authMode !== "oauth") return request;
  try {
    const destination = new URL(request.url);
    if (mayResolveModelsOAuth(name, provider) && authorizedTarget !== undefined
      && authorizedTarget === captureModelsOAuthTarget(name, provider) && destination.href === authorizedTarget
      && !destination.username && !destination.password && !destination.hash) return request;
  } catch { /* Malformed destinations carry no credential authority. */ }
  return { ...request, headers: Object.fromEntries(Object.entries(request.headers)
    .filter(([header]) => header.toLowerCase() !== "authorization")) };
}
