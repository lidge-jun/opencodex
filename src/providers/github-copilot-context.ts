import { modelRecordValue } from "../reasoning-effort";
import type { OcxProviderConfig } from "../types";

export const GITHUB_COPILOT_LONG_CONTEXT_WINDOW = 1_000_000;

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
  if (tier !== undefined) return { ...body, contextTier: tier };
  if (!Object.hasOwn(body, "contextTier")) return body;
  const safeBody = { ...body } as Record<string, unknown>;
  delete safeBody.contextTier;
  return safeBody;
}

export function githubCopilotCatalogContextWindow(
  providerName: string, provider: OcxProviderConfig, modelId: string, current: number | undefined,
): number | undefined {
  if (providerName !== "github-copilot" || configuredGithubCopilotContextTier(provider, modelId) !== "long_context") return current;
  return Math.max(current ?? 0, GITHUB_COPILOT_LONG_CONTEXT_WINDOW);
}
