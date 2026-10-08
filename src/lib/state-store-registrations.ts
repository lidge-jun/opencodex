import {
  getConfigDir,
  reconcileConfigWarningMemos,
  sweepDeadOcxStartProcessCache,
} from "../config";
import { reconcileCodexReauthState } from "../codex/account-runtime-state";
import { reconcileCatalogWarningMemos } from "../codex/catalog/aggregation";
import { reconcileProviderFetchWarnings } from "../codex/catalog/provider-fetch";
import { reconcileModelCacheGeneration } from "../codex/model-cache";
import { reconcilePoolRotationState } from "../codex/pool-rotation";
import { reconcileCodexQuotaAccounts } from "../codex/quota";
import { reconcileQuotaRecovery, sweepExpiredQuotaRecovery } from "../codex/quota-401-recovery";
import {
  listLiveCodexAccountIds,
  reconcileCodexRoutingHealth,
} from "../codex/routing";
import { sweepExpiredSubagentModelHealth } from "../codex/subagent-model-fallback";
import {
  reconcileComboTargetCooldowns,
  sweepExpiredComboTargetCooldowns,
} from "../combos/failover";
import { reconcileComboWarningMemos } from "../combos/request";
import { reconcileComboRotationState } from "../combos/resolve";
import { reconcileComboRecall, sweepExpiredComboRecall } from "../server/responses/combo-session-recall";
import { listLiveComboTargetKeys } from "../combos/types";
import {
  listLiveConfigOwnershipRoots,
  reconcileConfigOwnershipRoots,
} from "./config-ownership";
import { reconcileGcpAdcTokens, sweepExpiredGcpAdcTokens } from "./gcp-adc";
import {
  reconcileOAuthFlowState,
  sweepExpiredXaiPermanentFailureVerdicts,
} from "../oauth";
import { sweepAllAnthropicRoutingHealth, reconcileAnthropicRoutingState } from "../oauth/anthropic-routing";
import { reconcileAllAnthropicFamilyQuota } from "../oauth/anthropic-model-quota";
import { reconcileAllAnthropicRatePauses, sweepExpiredAllAnthropicRatePauses } from "../oauth/anthropic-rate-limit-policy";
import { reconcileAllAnthropicCooldownGenerations } from "../providers/quota/anthropic-cooldown-recovery";
import { configuredAnthropicInstance } from "../providers/anthropic-instance";
import { listLiveOAuthAccountKeys, reconcileOAuthReauthState } from "../oauth/store";
import { reconcileGuardianBackoff } from "../oauth/token-guardian";
import { sweepExpiredApiKeyCooldowns } from "../providers/key-failover";
import { reconcileProviderRequestPacing } from "../providers/request-pacing";
import { sweepAbandonedResponseStateTemps, sweepExpiredResponseStates, sweepOrphanedResponseSpills } from "../responses/state";
import { sweepExpiredAntigravityReplay } from "../adapters/google-antigravity-replay";
import { reconcileProviderAccountQuotaRows } from "../providers/quota";
import { reconcileRouterWarningMemos } from "../router";
import { configureSharedSpendLedger, spendPolicyFromConfig } from "./spend-reservation-ledger";
import type { OcxConfig } from "../types";
import {
  type GenerationContext,
  reconcileStateGeneration,
  registerStateStore,
  setGenerationContextBuilder,
  type StateStoreRegistration,
} from "./state-store-sweeper";

let liveServerConfig: OcxConfig | null = null;

export function setLiveStateStoreConfig(config: OcxConfig): void {
  liveServerConfig = config;
}

export function reconcileLiveStateStores() {
  if (!liveServerConfig) return { storesVisited: 0, rowsRemoved: 0 };
  // Only adopted live providers own canonical pools; detached disk snapshots may
  // contain providers the routing instance deliberately has not activated yet.
  configureSharedSpendLedger(spendPolicyFromConfig(liveServerConfig.spend,
    liveServerConfig.spendPoolAliases, Object.keys(liveServerConfig.providers)));
  return reconcileStateGeneration(buildGenerationContext());
}

export function buildGenerationContext(): GenerationContext {
  if (!liveServerConfig) throw new Error("live server config is not installed");
  const providerNames = new Set(Object.keys(liveServerConfig.providers));
  const oauthAccountKeys = new Set(listLiveOAuthAccountKeys(providerNames));
  if (configuredAnthropicInstance(liveServerConfig, "anthropic2") !== "anthropic2") {
    for (const key of oauthAccountKeys) if (key.startsWith("anthropic2\0")) oauthAccountKeys.delete(key);
  }
  return {
    generation: 0,
    providerNames,
    comboIds: new Set(Object.keys(liveServerConfig.combos ?? {})),
    comboTargets: listLiveComboTargetKeys(liveServerConfig),
    codexAccountIds: listLiveCodexAccountIds(liveServerConfig),
    oauthAccountKeys,
    configRoots: listLiveConfigOwnershipRoots(getConfigDir()),
  };
}

export const STATE_STORE_REGISTRATIONS = [
  { name: "subagent-model-health", sweepExpired: sweepExpiredSubagentModelHealth },
  { name: "api-key-cooldowns", sweepExpired: sweepExpiredApiKeyCooldowns },
  { name: "provider-request-pacing", reconcileGeneration: reconcileProviderRequestPacing },
  {
    name: "combo-target-cooldowns",
    sweepExpired: sweepExpiredComboTargetCooldowns,
    reconcileGeneration: reconcileComboTargetCooldowns,
  },
  { name: "anthropic-routing-health", sweepExpired: sweepAllAnthropicRoutingHealth,
    reconcileGeneration: context => reconcileAnthropicRoutingState(context, liveServerConfig ?? undefined) },
  { name: "anthropic-family-quota", reconcileGeneration: reconcileAllAnthropicFamilyQuota },
  { name: "anthropic-rate-pauses", sweepExpired: sweepExpiredAllAnthropicRatePauses, reconcileGeneration: reconcileAllAnthropicRatePauses },
  { name: "anthropic-cooldown-generations", reconcileGeneration: reconcileAllAnthropicCooldownGenerations },
  { name: "xai-refresh-verdicts", sweepExpired: sweepExpiredXaiPermanentFailureVerdicts },
  {
    name: "codex-quota-401-recovery",
    // Only backoff windows and abandoned leases expire. A spent fence is durable: expiring
    // it would grant the same credential lineage a second refresh (#3019).
    sweepExpired: sweepExpiredQuotaRecovery,
    reconcileGeneration: context => reconcileQuotaRecovery(context.codexAccountIds),
  },
  {
    name: "responses-continuation",
    sweepExpired: sweepExpiredResponseStates,
    // Disk reclaim rides the liveness tick, not the TTL tick: sweepExpiredOnWrite puts
    // sweepExpired on hot write paths, where a directory scan does not belong.
    sweepLiveness: () => sweepAbandonedResponseStateTemps() + sweepOrphanedResponseSpills(),
  },
  { name: "antigravity-replay", sweepExpired: sweepExpiredAntigravityReplay },
  { name: "config-warning-memos", reconcileGeneration: (context: GenerationContext) => reconcileConfigWarningMemos(context.generation) },
  { name: "catalog-warning-memos", reconcileGeneration: (context: GenerationContext) => reconcileCatalogWarningMemos(context.generation) },
  { name: "provider-fetch-warning-memos", reconcileGeneration: (context: GenerationContext) => reconcileProviderFetchWarnings(context.generation) },
  { name: "combo-warning-memos", reconcileGeneration: (context: GenerationContext) => reconcileComboWarningMemos(context.generation) },
  { name: "router-warning-memos", reconcileGeneration: (context: GenerationContext) => reconcileRouterWarningMemos(context.generation) },
  { name: "codex-quota", reconcileGeneration: reconcileCodexQuotaAccounts },
  { name: "provider-quota-history", reconcileGeneration: reconcileProviderAccountQuotaRows },
  { name: "codex-routing-health", reconcileGeneration: reconcileCodexRoutingHealth },
  { name: "model-cache-history", reconcileGeneration: reconcileModelCacheGeneration },
  { name: "pool-rotation", reconcileGeneration: reconcilePoolRotationState },
  { name: "combo-rotation", reconcileGeneration: reconcileComboRotationState },
  {
    name: "combo-session-recall",
    sweepExpired: sweepExpiredComboRecall,
    reconcileGeneration: reconcileComboRecall,
  },
  { name: "guardian-backoff", reconcileGeneration: reconcileGuardianBackoff },
  { name: "codex-reauth", reconcileGeneration: reconcileCodexReauthState },
  { name: "oauth-reauth", reconcileGeneration: reconcileOAuthReauthState },
  { name: "gcp-adc", sweepExpired: sweepExpiredGcpAdcTokens, reconcileGeneration: reconcileGcpAdcTokens },
  { name: "config-ownership", reconcileGeneration: reconcileConfigOwnershipRoots },
  { name: "oauth-flow-state", reconcileGeneration: reconcileOAuthFlowState },
  { name: "ocx-start-process-cache", sweepLiveness: sweepDeadOcxStartProcessCache },
] satisfies readonly StateStoreRegistration[];

for (const registration of STATE_STORE_REGISTRATIONS) registerStateStore(registration);

setGenerationContextBuilder(buildGenerationContext);
