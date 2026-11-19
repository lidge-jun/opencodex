import type { OcxConfig, OcxProviderConfig, OcxComboConfig } from "../../types";

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

function dataValue<T, K extends keyof T>(value: T | undefined, key: K): T[K] | undefined {
  const descriptor = value == null ? undefined : Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value as T[K] : undefined;
}

function copyMetadata(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === "function") throw new TypeError("Admission metadata must contain only data");
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  const copy = Array.isArray(value) ? new Array(dataValue(value, "length")) : {};
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
    Object.defineProperty(copy, key, {
      value: copyMetadata(descriptor.value, seen), enumerable: true, writable: true, configurable: true,
    });
  }
  return copy;
}

function pickMetadata<T, K extends keyof T>(value: T, fields: readonly K[]): Pick<T, K> {
  return Object.fromEntries(fields.map(field => [field, copyMetadata(dataValue(value, field))])) as Pick<T, K>;
}

function projectRows<T, R>(rows: readonly T[] | undefined, project: (row: T) => R): R[] | undefined {
  if (!rows) return undefined;
  const result: R[] = [];
  const length = dataValue(rows, "length") ?? 0;
  for (let index = 0; index < length; index++) {
    const row = dataValue(rows, index);
    if (row !== undefined) result.push(project(row));
  }
  return result;
}

/** The capability gate consumes this detached provider view. Credential resolution uses live routing. */
export function snapshotComboAdmissionProvider(provider: OcxProviderConfig) {
  return {
    ...pickMetadata(provider, providerFields),
    apiKeyPoolIdentity: projectRows(dataValue(provider, "apiKeyPool"), row => pickMetadata(row, ["id", "disabled", "pauseRevision"])),
  };
}

/**
 * The request-start copy combo admission reads. The capability gate awaits sidecar planning, so
 * reading the live config afterwards could mix two configurations in one verdict. Only data
 * properties are copied: a getter (a lazily resolved credential, say) is never invoked.
 */
export function snapshotComboAdmission(config: OcxConfig, comboId: string) {
  const rawCombo = dataValue(dataValue(config, "combos"), comboId);
  const providers = dataValue(config, "providers") ?? {};
  const vision = dataValue(config, "visionSidecar");
  return {
    rawCombo: rawCombo && copyMetadata(rawCombo) as OcxComboConfig,
    providers: Object.fromEntries(Object.keys(providers).flatMap(name => {
      const provider = dataValue(providers, name);
      return provider && dataValue(provider, "adapter") !== "jev-decision"
        ? [[name, snapshotComboAdmissionProvider(provider)] as const] : [];
    })),
    customModels: projectRows(dataValue(config, "customModels"), row => pickMetadata(row, [
      "id", "provider", "modelId", "inputModalities", "contextWindow", "reasoningEfforts",
      "defaultReasoningEffort", "codexToolMode",
    ])),
    providerContextCaps: copyMetadata(dataValue(config, "providerContextCaps")) as OcxConfig["providerContextCaps"],
    vision: vision && pickMetadata(vision, [
      "enabled", "backend", "model", "anthropicInstance", "maxDescriptionsPerTurn", "timeoutMs", "reasoning",
    ]),
  };
}

/** The config with one combo's roster pinned to its request-start copy, for post-decision choices. */
export function requestStartComboConfig(config: OcxConfig, comboId: string, rawCombo: OcxComboConfig | undefined): OcxConfig {
  return { ...config, combos: rawCombo ? { [comboId]: rawCombo } : {} };
}
