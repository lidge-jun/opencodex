import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OcxConfig } from "./types";
import { configReasoningPinsConfigError } from "./config/provider-validation";
import { recordOwnedConfigPath } from "./lib/config-ownership";
import { assertNotRealHomeUnderTest } from "./lib/test-home-guard";
import {
  adoptCustomModelCatalogMigration,
  projectCustomModelCatalogMigration,
} from "./codex/custom-model-catalog-migration";
import { refreshUserCostOverlays } from "./usage/user-cost-overlays";
import {
  clearPendingConfigDeletions,
  projectConfigRebaseProvenance,
} from "./config/rebase-provenance";
import { getConfigDir, getConfigPath, hardenConfigDir } from "./config/paths";
export { DEFAULT_SUBAGENT_MODELS } from "./config/subagent-models";
export {
  AtomicWriteResidualTempError,
  AtomicWriteSecretResidualError,
  atomicWriteFile,
  atomicWriteFileAsync,
  renameAtomicFile,
  resolveWriteTarget,
  type AtomicRenameIO,
  type AtomicWriteAsyncIO,
  type AtomicWriteAsyncTestSeam,
  type AtomicWriteIO,
} from "./config/atomic-write";
export { expandUserPath, getConfigDir, getConfigPath, hardenConfigDir } from "./config/paths";
export {
  getPidPath,
  getRuntimePortPath,
  isOcxStartCommandLine,
  ocxStartProcessCacheSizeForTests,
  parsePidFile,
  readAlivePid,
  readPid,
  readPidFileValue,
  readRuntimePort,
  removePid,
  removePidIfValueIs,
  removeRuntimePort,
  removeRuntimePortIfPidIs,
  setOcxStartProcessCacheForTests,
  setOcxStartProcessProbeForTests,
  setProcessCommandLineExecForTests,
  setProcessCommandLinePlatformForTests,
  sweepDeadOcxStartProcessCache,
  verifyPidIdentity,
  writePid,
  writeRuntimePort,
  type RuntimePortState,
} from "./config/process-state";
export { deleteConfigTopLevelKey } from "./config/rebase-provenance";
export {
  mutatePersistedConfig,
  setPersistedConfigMutationBeforeCommitForTests,
  type PersistedConfigMutation,
  type PersistedConfigMutationOutcome,
} from "./config/persisted-mutation";
export { isValidProviderName, hasOwnProvider } from "./config/provider-name";
export {
  apiKeyTransportConfigError,
  booleanRecordConfigError,
  modelAdapterRecordConfigError,
  modelDisplayNamesConfigError,
  autoReviewModelOverridesConfigError,
  autoReviewModelTargetConfigError,
  nonBlankStringArrayConfigError,
  normalizeNonBlankStringArray,
  normalizeAutoReviewModelOverrides,
  positiveIntegerConfigError,
  positiveIntegerRecordConfigError,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  reasoningSummaryDeliveryRecordConfigError,
  upstreamHttpVersionConfigError,
} from "./config/provider-validation";
export { reconcileConfigWarningMemos } from "./config/warn-memo";
export {
  OpenAiTierBackupCleanupError,
  OpenAiTierBackupRollbackError,
  OpenAiTierBackupCollisionError,
  OpenAiTierRollbackPreserveError,
  OpenAiTierBackupSecretResidualError,
  classifyOpenAiTierBackup,
  backupConfigBeforeOpenAiTierMigration,
  preserveOpenAiTierRollbackSnapshot,
  type OpenAiTierBackupIO,
  type OpenAiTierRollbackPreserveIO,
} from "./config/openai-tier-backup";
export {
  websocketsEnabled,
  ultraFastTierEnabled,
  CATALOG_AUTO_REFRESH_DEFAULT_INTERVAL_MS,
  CATALOG_AUTO_REFRESH_MIN_INTERVAL_MS,
  isCatalogAutoRefreshEnabled,
  resolveCatalogAutoRefreshIntervalMs,
} from "./config/feature-flags";
export {
  codexAutoStartEnabled,
  CODEX_SHIM_AUTO_RESTORE_ENV,
  codexShimAutoRestoreEnabled,
  multiAgentGuidanceEnabled,
  runtimeRole,
  getDefaultConfig,
  resolveEnvValue,
  applyProxyEnv,
  applyProxyEnvWith,
} from "./config/proxy-env";
export {
  requestPacingConfigError,
  providerWebSearchBridgeConfigError,
  providerModelCostsConfigError,
  sanitizeModelCostsForDisplay,
  modelPreferHostedToolsConfigError,
} from "./config/schema/leaf-validators";
export { hardenExistingSecret, retryOn429PolicyConfigError, retryOnResetPolicyConfigError } from "./config/load-degrade";
export { backupInvalidConfig } from "./config/salvage";
export type { ConfigDiagnostics, ConfigAdmissionSnapshot } from "./config/diagnostics";
export {
  subagentDefaultSyncEffective,
  loopbackCompanionBindError,
  validateConfigCandidate,
  readConfigDiagnostics,
  observeInitialConfigState,
  readConfigAdmissionSnapshot,
} from "./config/diagnostics";
export {
  ConfigMutationLockError,
  NestedConfigMutationError,
  prepareConfigMutationDatabasePathForWrite,
  withConfigMutationLockSync,
  readConfigGeneration,
  observeConfigGeneration,
  readConfigGenerationInCurrentMutationTransaction,
  bumpConfigGeneration,
  withExpectedConfigGenerationSync,
} from "./config/mutation-lock";
export {
  armClaudeCodeBaseline, armDetachedConfigBaseline,
  adoptPersistedClaudeCode, adoptPersistedProviderIntoLiveConfig,
  claudeCodeBaselineArmed,
  reconcileLiveConfigFromDisk,
  saveConfigPreservingClaudeCode,
} from "./config/live-reconcile";

// create-only path — never persist-unlocked / atomicWriteFile
import { InitialConfigPublicationError, publishInitialConfigNoReplace, type InitialConfigPublicationIO } from "./config/initialize";
import { observeInitialConfigState } from "./config/diagnostics";
import {
  configDiagnosticsFromRaw,
  mergeConfigDefaults,
  validateConfigCandidate,
} from "./config/diagnostics";

// replace path — never publishInitialConfigNoReplace
import { persistConfigUnlocked, readRawConfigJson } from "./config/persist-unlocked";

import { withConfigMutationLockSync, bumpGenerationForCooperatingConfigWrite } from "./config/mutation-lock";
import { getDefaultConfig } from "./config/proxy-env";
import { configSchema } from "./config/schema/config-schema";
import {
  hardenExistingSecret,
  normalizeApiKeyIds,
  normalizeClaudeSubagentEffort,
  normalizeNativeSubagentSync,
  sanitizeAliasesForLoad,
  sanitizeReasoningPinsForLoad,
  sanitizeModelDisplayNamesForLoad,
  sanitizeAutoReviewForLoad,
  sanitizeRetryOn429ForLoad,
  sanitizeModelCostsForLoad,
  sanitizeCapabilityDeclarationsForLoad,
  warnInheritedFastWireConflicts,
  warnDegradedTopLevelOptIns,
  warnDegradedHostname,
  warnDegradedListeners,
  warnDegradedApiKeys,
  warnDegradedCodexAccountPriorities,
  warnDegradedCodexQuotaAutoRefresh,
  warnDegradedClaudeSubagentEffort,
  warnDegradedNativeSubagentConfig,
  warnDegradedCodexAccountPicker,
  warnDegradedUpstreamHostCircuitThreshold,
  warnDegradedPlaintextV2AgentMessages,
  warnDegradedAgentTaskRecovery,
  warnDegradedRuntimeRole,
  warnDegradedOptionalRemoteBlocks,
  warnDegradedQuotaResetNotify,
  warnDegradedCatalogAutoRefresh,
  warnDegradedCodexPool,
  warnDegradedCredentialGroups,
  withRefreshedCostOverlays,
} from "./config/load-degrade";
import {
  salvageConfigCandidate,
  warnConfigRepaired,
  warnDroppedConfigSections,
  warnAndBackupInvalidConfig,
} from "./config/salvage";

/**
 * Load and validate config.json into an OcxConfig. Missing files reset to
 * defaults and clear stale overlays. Broken existing files also fall back to
 * default routing (after backup), but keep the last-good cost-overlay registry
 * until a valid config or a genuinely missing file is observed. A partially-
 * invalid config is merged with defaults so providers and pool accounts survive.
 */
export function loadConfig(): OcxConfig {
  const dir = getConfigDir();
  const configPath = getConfigPath();
  hardenConfigDir();
  hardenExistingSecret(configPath);
  hardenExistingSecret(join(dir, "auth.json"));
  if (!existsSync(configPath)) {
    return withRefreshedCostOverlays(getDefaultConfig());
  }
  try {
    const raw = readFileSync(configPath, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    sanitizeAliasesForLoad(parsed);
    sanitizeReasoningPinsForLoad(parsed);
    sanitizeModelDisplayNamesForLoad(parsed);
    sanitizeAutoReviewForLoad(parsed);
    sanitizeRetryOn429ForLoad(parsed);
    sanitizeModelCostsForLoad(parsed);
    sanitizeCapabilityDeclarationsForLoad(parsed);
    const result = configSchema.safeParse(parsed);
    if (result.success) {
      const config = normalizeApiKeyIds(result.data as OcxConfig);
      warnInheritedFastWireConflicts(configPath, config);
      warnDegradedTopLevelOptIns(parsed, config);
      warnDegradedHostname(parsed, config);
      warnDegradedListeners(parsed, config);
      warnDegradedApiKeys(parsed, config);
      warnDegradedCodexAccountPriorities(parsed, config);
      warnDegradedCodexQuotaAutoRefresh(parsed, config);
      warnDegradedClaudeSubagentEffort(parsed);
      warnDegradedNativeSubagentConfig(parsed, config);
      warnDegradedCodexAccountPicker(parsed);
      warnDegradedUpstreamHostCircuitThreshold(parsed);
      warnDegradedPlaintextV2AgentMessages(parsed);
      warnDegradedAgentTaskRecovery(parsed);
      warnDegradedRuntimeRole(parsed);
      warnDegradedOptionalRemoteBlocks(parsed);
      warnDegradedQuotaResetNotify(parsed);
      warnDegradedCatalogAutoRefresh(parsed);
      warnDegradedCodexPool(parsed);
      warnDegradedCredentialGroups(parsed);
      return withRefreshedCostOverlays(normalizeClaudeSubagentEffort(normalizeNativeSubagentSync(config, parsed), parsed));
    }
    // Only object-shaped configs are repairable. Spreading another JSON value
    // into defaults can manufacture a valid config and bypass the invalid-file
    // backup.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnAndBackupInvalidConfig(configPath, result.error);
      return getDefaultConfig();
    }
    // Schema validation failed — merge defaults into the raw object instead of
    // discarding it entirely, so pool accounts and providers survive a missing
    // field like defaultProvider.
    const merged = mergeConfigDefaults(parsed);
    const retryResult = configSchema.safeParse(merged);
    if (retryResult.success) {
      warnConfigRepaired(configPath, result.error);
      const config = normalizeApiKeyIds(retryResult.data as OcxConfig);
      warnInheritedFastWireConflicts(configPath, config);
      warnDegradedHostname(parsed, config);
      warnDegradedListeners(parsed, config);
      warnDegradedApiKeys(parsed, config);
      warnDegradedCodexAccountPriorities(parsed, config);
      warnDegradedCodexQuotaAutoRefresh(parsed, config);
      warnDegradedClaudeSubagentEffort(parsed);
      warnDegradedNativeSubagentConfig(parsed, config);
      warnDegradedCodexAccountPicker(parsed);
      warnDegradedUpstreamHostCircuitThreshold(parsed);
      warnDegradedPlaintextV2AgentMessages(parsed);
      warnDegradedAgentTaskRecovery(parsed);
      warnDegradedRuntimeRole(parsed);
      warnDegradedOptionalRemoteBlocks(parsed);
      warnDegradedQuotaResetNotify(parsed);
      warnDegradedCatalogAutoRefresh(parsed);
      warnDegradedCodexPool(parsed);
      warnDegradedCredentialGroups(parsed);
      return withRefreshedCostOverlays(normalizeClaudeSubagentEffort(normalizeNativeSubagentSync(config, parsed), parsed));
    }
    // Still failing, but if every complaint is about one or more named entries
    // in an independent section, drop exactly those and keep the rest. Falling
    // back to defaults here would silently retire the operator's providers,
    // keys and prices over a mistake in one routing profile.
    const salvaged = salvageConfigCandidate(merged, retryResult.error);
    if (salvaged) {
      {
        warnDroppedConfigSections(configPath, salvaged.dropped, salvaged.issues);
        const config = normalizeApiKeyIds(salvaged.parsed);
        warnInheritedFastWireConflicts(configPath, config);
        warnDegradedHostname(parsed, config);
        warnDegradedListeners(parsed, config);
        warnDegradedApiKeys(parsed, config);
        warnDegradedCodexAccountPriorities(parsed, config);
        warnDegradedCodexQuotaAutoRefresh(parsed, config);
        warnDegradedClaudeSubagentEffort(parsed);
        warnDegradedNativeSubagentConfig(parsed, config);
        warnDegradedCodexAccountPicker(parsed);
        warnDegradedUpstreamHostCircuitThreshold(parsed);
        warnDegradedPlaintextV2AgentMessages(parsed);
        warnDegradedAgentTaskRecovery(parsed);
        warnDegradedRuntimeRole(parsed);
        warnDegradedOptionalRemoteBlocks(parsed);
        warnDegradedQuotaResetNotify(parsed);
        warnDegradedCatalogAutoRefresh(parsed);
        warnDegradedCodexPool(parsed);
        warnDegradedCredentialGroups(parsed);
        return withRefreshedCostOverlays(normalizeClaudeSubagentEffort(normalizeNativeSubagentSync(config, parsed), parsed));
      }
    }
    // Merge couldn't fix it — truly broken config
    warnAndBackupInvalidConfig(configPath, result.error);
    return getDefaultConfig();
  } catch (error) {
    warnAndBackupInvalidConfig(configPath, error);
    return getDefaultConfig();
  }
}

export type PersistedConfigInitializationOutcome = "created" | "exists" | "invalid";

/** Initialize only a missing config; ordinary explicit updates still use saveConfig. */
export function initializePersistedConfigIfMissing(
  config: OcxConfig,
  io?: Partial<InitialConfigPublicationIO>,
): PersistedConfigInitializationOutcome {
  assertNotRealHomeUnderTest(getConfigDir());
  const before = observeInitialConfigState();
  if (before !== "missing") return before;
  let published = false;
  try {
    const persisted = withConfigMutationLockSync((): OcxConfig | "exists" | "invalid" => {
      const current = observeInitialConfigState();
      if (current !== "missing") return current;
      const projected = projectCustomModelCatalogMigration(undefined, projectConfigRebaseProvenance(config));
      if (!validateConfigCandidate(projected).ok) throw new Error("Initial configuration is invalid.");
      if (!publishInitialConfigNoReplace(getConfigPath(), JSON.stringify(projected, null, 2) + "\n", io)) {
        return observeInitialConfigState() === "exists" ? "exists" : "invalid";
      }
      published = true;
      recordOwnedConfigPath(getConfigDir(), getConfigPath());
      bumpGenerationForCooperatingConfigWrite();
      return projected;
    });
    if (typeof persisted === "string") return persisted;
    adoptCustomModelCatalogMigration(config, persisted);
    if (persisted.configRebaseProvenance === undefined) delete config.configRebaseProvenance;
    else config.configRebaseProvenance = structuredClone(persisted.configRebaseProvenance);
    clearPendingConfigDeletions(config);
    refreshUserCostOverlays(persisted);
    return "created";
  } catch (cause) {
    if (published) throw new InitialConfigPublicationError("published", false, false, { cause });
    throw cause;
  }
}

/** Persist `config` to config.json under the config-mutation lock. */
export function saveConfig(config: OcxConfig): void {
  const pinError = configReasoningPinsConfigError(config);
  if (pinError) throw new Error(pinError);
  // Keep the real-home assertion ahead of even lock-directory preparation.
  assertNotRealHomeUnderTest(getConfigDir());
  withConfigMutationLockSync(() => {
    const withProvenance = projectCustomModelCatalogMigration(
      readRawConfigJson(),
      projectConfigRebaseProvenance(config),
    );
    if (persistConfigUnlocked(withProvenance)) bumpGenerationForCooperatingConfigWrite();
    adoptCustomModelCatalogMigration(config, withProvenance);
    if (withProvenance.configRebaseProvenance === undefined) delete config.configRebaseProvenance;
    else config.configRebaseProvenance = structuredClone(withProvenance.configRebaseProvenance);
    clearPendingConfigDeletions(config);
  });
}
