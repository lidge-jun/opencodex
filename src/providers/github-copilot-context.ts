import { modelRecordValue } from "../reasoning-effort";
import type { OcxContextTier, OcxProviderConfig } from "../types";

/** GitHub Copilot's long-context tier is exposed as a one-million-token capability. */
export const GITHUB_COPILOT_LONG_CONTEXT_WINDOW = 1_000_000;

export function configuredGithubCopilotContextTier(
  provider: OcxProviderConfig,
  modelId: string,
): OcxContextTier | undefined {
  const tier = modelRecordValue(provider.modelContextTiers, modelId);
  return tier === "default" || tier === "long_context" ? tier : undefined;
}

/**
 * The tier is an opt-in provider setting. Keep an unconfigured body byte-for-byte compatible and
 * fail closed if a future adapter hands us a non-object payload.
 */
export function applyGithubCopilotContextTier(
  body: unknown,
  provider: OcxProviderConfig,
  modelId: string,
): unknown {
  const tier = configuredGithubCopilotContextTier(provider, modelId);
  if (!tier || !body || typeof body !== "object" || Array.isArray(body)) return body;
  return { ...(body as Record<string, unknown>), contextTier: tier };
}

/** Raise only the Copilot long-context capability; provider caps are applied afterwards. */
export function githubCopilotCatalogContextWindow(
  providerName: string,
  provider: OcxProviderConfig,
  modelId: string,
  current: number | undefined,
): number | undefined {
  if (providerName !== "github-copilot" || configuredGithubCopilotContextTier(provider, modelId) !== "long_context") {
    return current;
  }
  return Math.max(current ?? 0, GITHUB_COPILOT_LONG_CONTEXT_WINDOW);
}
