import type { OcxProviderConfig } from "../types";
import { anthropicInstanceRowShapeMatches } from "../providers/anthropic-instance-id";

/** Discovery owns its configured row (a frozen capture for catalog gathers), not live config. */
export function mayResolveModelsOAuth(name: string, provider: OcxProviderConfig | undefined): boolean {
  return name !== "anthropic2" || (provider !== undefined && provider.disabled !== true
    && anthropicInstanceRowShapeMatches(name, provider));
}

/** A supplied snapshot cannot authorize sending Pool 2's bearer to a custom destination. */
export function guardModelsOAuthRequest<T extends { url: string; headers: Record<string, string> }>(
  name: string,
  provider: OcxProviderConfig,
  request: T,
): T {
  if (name !== "anthropic2" || provider.authMode !== "oauth") return request;
  const destination = new URL(request.url);
  if (mayResolveModelsOAuth(name, provider) && destination.origin === "https://api.anthropic.com"
    && !destination.username && !destination.password) return request;
  return { ...request, headers: Object.fromEntries(Object.entries(request.headers)
    .filter(([header]) => header.toLowerCase() !== "authorization")) };
}
