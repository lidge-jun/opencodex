import { setConfiguredNativeOpenAiModels } from "../codex/catalog/native-models";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers-destination";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { refreshUserCostOverlays } from "../usage/user-cost-overlays";

/**
 * Bare `gpt-*` ids listed under `providers.openai.models` that become configured natives.
 *
 * Only the canonical Codex forward provider qualifies (an omitted authMode is the registry's
 * forward default): `providers.openai.models` is otherwise ignored for that provider, and on any
 * other shape the list means routed models, which must not turn into native rows.
 */
export function configuredNativeOpenAiModelIds(config: Pick<OcxConfig, "providers">): string[] {
  const provider = config.providers?.[OPENAI_CODEX_PROVIDER_ID] as OcxProviderConfig | undefined;
  if (!provider || provider.disabled === true || !Array.isArray(provider.models)) return [];
  const canonical = provider.authMode === undefined ? { ...provider, authMode: "forward" as const } : provider;
  if (!isCanonicalOpenAiForwardProvider(canonical)) return [];
  return provider.models.flatMap(id => typeof id === "string" ? [id.trim()] : []);
}

/**
 * Rebuild every process-local registry derived from a committed config: user price overlays and
 * configured native GPT models. Called wherever a loaded, persisted or reconciled config becomes
 * current, so the two never disagree about which config is live.
 */
export function refreshConfigDerivedRegistries(config: OcxConfig): void {
  refreshUserCostOverlays(config);
  setConfiguredNativeOpenAiModels(configuredNativeOpenAiModelIds(config));
}
