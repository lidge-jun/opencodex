import type { OcxConfig } from "../types";
import {
  filterCatalogVisibleModels,
  nativeContextLimits,
  orderForSubagents,
  type CatalogModel,
  type NativeContextLimits,
} from "../codex/catalog";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "../codex/catalog/native-models";
import {
  availableAccountGatedNativeModels,
  type CodexModelEntitlementSnapshot,
} from "../codex/model-entitlements";
import { MAIN_CODEX_ACCOUNT_ID } from "../codex/main-account";
import { providerCodexAccountMode } from "../providers/registry";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";

export interface DesktopDiscoveryInputs {
  nativeSlugs: string[];
  routedModels: CatalogModel[];
  nativeContextCap: NativeContextLimits;
}

/** Project captured discovery state without reading caches or installing aliases. */
export function buildDesktopDiscoveryInputs(options: {
  config: OcxConfig;
  models: readonly CatalogModel[];
  modelEntitlements: CodexModelEntitlementSnapshot;
  desktopNativeCandidates: readonly string[];
}): DesktopDiscoveryInputs {
  const { config, models, modelEntitlements, desktopNativeCandidates } = options;
  const eligibleAccountIds = providerCodexAccountMode(
    OPENAI_CODEX_PROVIDER_ID,
    config.providers[OPENAI_CODEX_PROVIDER_ID],
  ) === "direct" ? new Set([MAIN_CODEX_ACCOUNT_ID]) : undefined;
  const available = availableAccountGatedNativeModels(modelEntitlements, eligibleAccountIds);
  return {
    nativeSlugs: desktopNativeCandidates.filter(slug => (
      !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug) || available.has(slug)
    )),
    routedModels: orderForSubagents(filterCatalogVisibleModels([...models], config), config.subagentModels),
    nativeContextCap: nativeContextLimits(config),
  };
}
