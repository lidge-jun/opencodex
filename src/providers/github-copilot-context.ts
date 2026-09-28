import { modelRecordValue } from "../reasoning-effort";
import type { OcxProviderConfig } from "../types";

export function configuredGithubCopilotContextTier(provider: OcxProviderConfig, modelId: string): "default" | "long_context" | undefined {
  const tier = modelRecordValue(provider.modelContextTiers, modelId);
  return tier === "default" || tier === "long_context" ? tier : undefined;
}

/** Only the routed Copilot provider may receive this nonstandard upstream field. */
export function applyGithubCopilotContextTier(
  body: unknown, provider: OcxProviderConfig, modelId: string, providerName?: string,
): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const tier = providerName === "github-copilot" ? configuredGithubCopilotContextTier(provider, modelId) : undefined;
  return tier === undefined ? body : { ...body, contextTier: tier };
}

export function githubCopilotCatalogContextWindow(
  providerName: string, provider: OcxProviderConfig, modelId: string, current: number | undefined,
): number | undefined {
  if (providerName !== "github-copilot" || configuredGithubCopilotContextTier(provider, modelId) !== "long_context") return current;
  // The tier choice alone is not evidence of a larger window. An exact per-model declaration
  // from the operator or captured registry is authoritative; it can also cap a live window.
  const supported = provider.modelContextWindows && Object.hasOwn(provider.modelContextWindows, modelId)
    ? provider.modelContextWindows[modelId] : undefined;
  return typeof supported === "number" && Number.isSafeInteger(supported) && supported > 0 ? supported : current;
}
