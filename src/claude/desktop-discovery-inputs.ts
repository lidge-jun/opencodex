import type { OcxConfig } from "../types";
import { desktop3pModelOptions } from "./desktop-3p";
import {
  filterCatalogVisibleModels,
  nativeContextLimits,
  orderForSubagents,
  type CatalogModel,
  type NativeContextLimits,
} from "../codex/catalog";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "../codex/catalog/native-models";
import { codexAccountNamespaceEntries } from "../codex/account-namespaces";
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

/** Capture listing policy by value because management updates the live config in place. */
export function desktopSnapshotPolicyIdentity(config: OcxConfig): string {
  const discovery = config.modelDiscovery;
  // Baseline membership affects visibility for collapsed Antigravity effort families.
  const knownModels = Object.entries(discovery?.knownModels ?? {}).map(([provider, baseline]) =>
    [provider, [...new Set([...baseline.ids, ...baseline.removed])].sort()]);
  // Hash provider settings with the policy so the snapshot retains no credential material.
  return new Bun.CryptoHasher("sha256").update(JSON.stringify({
    enabled: config.claudeCode?.enabled !== false,
    desktopNativeModels: config.claudeCode?.desktopNativeModels !== false,
    profile: config.claudeCode?.desktopProfile,
    desktopOptions: desktop3pModelOptions(config.claudeCode),
    disabledModels: [...new Set(config.disabledModels)].sort(),
    providers: config.providers,
    newModelPolicy: discovery?.newModelPolicy ?? "on",
    knownModels,
    combos: config.combos,
    customModels: config.customModels,
    providerContextCaps: config.providerContextCaps,
    subagentModels: config.subagentModels,
    visionSidecarEnabled: config.visionSidecar?.enabled !== false,
    codexAccountPickerEnabled: config.codexAccountPickerEnabled,
    codexAccountNamespaces: codexAccountNamespaceEntries(config),
    poolAccountIds: config.codexAccounts?.filter(account => !account.isMain).map(account => account.id),
  })).digest("hex");
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
