import { getCombo } from "../../combos";
import { resolveProtocolSettings } from "../../protocols/settings";
import type { OcxConfig, OcxProviderConfig } from "../../types";

const providerFields = [
  "adapter", "authMode", "baseUrl", "codexAccountMode", "anthropicOAuthInstance", "disabled",
  "alias", "aliasTemplate", "defaultAliases", "modelAliases", "modelAdapters",
  "models", "selectedModels", "defaultModel", "modelSuffixBracketStrip", "modelDiscovery",
  "responsesPath", "chatCompletionsPath", "liveModels",
  "contextWindow", "modelContextWindows", "modelContextTiers", "inferContextWindow",
  "modelMaxInputTokens", "modelAutoCompactTokenLimits", "modelMaxOutputTokens",
  "minMaxOutputTokens", "defaultMaxOutputTokens", "modelCapabilities", "inputModalities",
  "modelInputModalities", "noVisionModels", "reasoningEfforts", "modelReasoningEfforts",
  "pinnedReasoningEffort", "modelPinnedReasoningEfforts", "modelDefaultReasoningEfforts",
  "noReasoningModels", "modelSuppressSyntheticMax", "supportsResponsesCustomTools",
  "dropResponsesReasoningItems", "preserveReasoningContentModels", "allowEncryptedV2AgentTasks", "keyOptional",
  "allowPrivateNetwork", "googleMode", "fastWire", "apiKeySelectionRevision",
  "forwardAdvisorTool", "autoToolChoiceOnlyModels", "preserveResponsesReasoningContent", "requiresAdjacentResponsesToolResults",
] as const satisfies readonly (keyof OcxProviderConfig)[];

/** The capability gate consumes this detached provider view. Credential resolution uses live routing. */
export function snapshotComboAdmissionProvider(provider: OcxProviderConfig) {
  return {
    ...pickMetadata(provider, providerFields),
    apiKeyPoolIdentity: provider.apiKeyPool?.map(entry => ({ id: entry.id, disabled: entry.disabled, pauseRevision: entry.pauseRevision })),
  };
}

function pickMetadata<T, K extends keyof T>(value: T, fields: readonly K[]): Pick<T, K> {
  const entries = fields.map(field => [field, value[field]] as const);
  return structuredClone(Object.fromEntries(entries)) as Pick<T, K>;
}

/** Compare routing and policy metadata across the asynchronous capability check. */
export function snapshotComboAdmission(config: OcxConfig, comboId: string) {
  return {
    combo: getCombo(config, comboId),
    protocols: resolveProtocolSettings(config),
    routing: pickMetadata(config, [
      "hostname", "port", "unauthenticatedLoopbackListener", "defaultProvider", "defaultModelAliases",
      "cursorEffortRows", "fastRows", "providerContextCaps", "blockedModelRedirects",
      "codexAccountNamespaces", "codexAccountPickerEnabled", "pausedCodexAccountIds",
      "codexMainAccountHardLock", "codexMainAccountHardLockThresholds", "codexDesktopAuthless",
      "codexReserveEnabled", "codexReserveMigration", "runtimeRole", "creditCodexAccountIds",
      "codexUseRemainingQuotaAccountIds",
    ]),
    providers: Object.fromEntries(Object.entries(config.providers)
      .filter(([, provider]) => provider.adapter !== "jev-decision")
      .map(([name, provider]) => [name, snapshotComboAdmissionProvider(provider)])),
    customModels: config.customModels?.map(row => pickMetadata(row, [
      "id", "provider", "modelId", "inputModalities", "contextWindow", "reasoningEfforts",
      "defaultReasoningEffort", "codexToolMode",
    ])),
    vision: config.visionSidecar && pickMetadata(config.visionSidecar, [
      "enabled", "backend", "model", "anthropicInstance", "maxDescriptionsPerTurn", "timeoutMs",
    ]),
    callerKeys: config.apiKeys?.map(row => ({
      ...pickMetadata(row, ["id", "createdAt", "allowedProviders", "allowedModels", "allowMeteredComboTargets"]),
      rotation: row.pendingRotation && pickMetadata(row.pendingRotation, ["id", "createdAt", "expiresAt"]),
    })),
    accounts: config.codexAccounts?.map(row => pickMetadata(row, ["id", "isMain", "plan", "planCredentialGeneration"])),
  };
}
