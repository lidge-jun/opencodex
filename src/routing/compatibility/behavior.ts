import { modelRecordValue } from "../../reasoning-effort";
import { modelInList } from "../../types";
import type { OcxConfig, OcxProviderConfig } from "../../types";
import { PROVIDER_REGISTRY } from "../../providers/registry";
import { fastPolicyForModel, serviceTierSupportFromPolicy } from "../../providers/service-tier";
import { resolveProviderAuthTransport } from "../../providers/fastwire";
import { localFingerprint } from "../../lab/digest";
import type { LabBehaviorSource, LabBehaviorValues } from "../../lab/live/types";

export function upstreamProtocolForAdapter(adapter: string): string {
  switch (adapter) {
    case "openai-responses":
      return "openai-responses";
    case "openai-chat":
    case "command-code":
    case "cursor":
    case "azure":
    case "azure-openai":
    case "kiro":
    case "mimo-free":
      return "openai-chat";
    case "anthropic":
      return "anthropic-messages";
    case "google":
      return "google-generate";
    default:
      return "openai-responses";
  }
}

export function surfaceForProtocols(inboundProtocol: string, upstreamProtocol: string): string {
  if (inboundProtocol === "anthropic-messages") return "anthropic-messages-http";
  if (upstreamProtocol === "anthropic-messages") return "responses-http";
  if (upstreamProtocol === "openai-chat") return "responses-sse";
  return "responses-http";
}

function behaviorRow(source: LabBehaviorSource, value: unknown) {
  return { source, value };
}

/**
 * Membership for the provider's `no*Models`-style lists.
 *
 * Delegates to modelInList so the report matches the wire: every runtime gate these
 * rows describe (openai-chat's sampling/reasoning/tool-choice gates, reasoning-effort's
 * noReasoningModels) matches through modelInList, which also accepts a bare entry for a
 * tagged id. ollama-cloud serves `gpt-oss:120b` and lists the bare `gpt-oss`, so an
 * exact-only check here reported "temperature is sent" on a request that omits it.
 */
function includesModel(list: string[] | undefined, modelId: string): boolean {
  return modelInList(list, modelId);
}

/**
 * Per-model override lookup for the nine family-aware report rows.
 *
 * Delegates to modelRecordValue so the report reads these maps the way the
 * runtime does -- own properties only, then the pre-colon family, then a
 * case-folded key. A bare index disagreed on all three: it missed the
 * `gpt-oss` entry ollama-cloud's `gpt-oss:120b` actually resolves, missed a
 * differently-cased key, and walked the prototype chain, so a routed model id
 * of `constructor`/`toString` yielded an Object.prototype function. That last
 * one made buildBehaviorFingerprintV1 throw ("unsupported value type
 * function"); the caller catches it (`src/routing/compatibility/subject.ts:125`)
 * and returns no route, so the subject is silently dropped -- and the linker
 * contract says implementations do not throw.
 *
 * Not every override map belongs here. `modelPreferHostedTools` and
 * `modelOpenRouterRouting` are exact-own at runtime and go through
 * `exactOwnValue` below; widening those to the family would be this same bug
 * with the sign flipped.
 */
function modelValue<T>(map: Record<string, T> | undefined, modelId: string): T | undefined {
  return modelRecordValue(map, modelId);
}

/**
 * Exact, own-property lookup for the two maps the runtime resolves that way.
 *
 * `modelPreferHostedTools` and `modelOpenRouterRouting` are deliberately exact: the
 * adapter reads the first through `hasOwnProperty`
 * (`src/adapters/openai-responses.ts:1001`) and the second through `Object.hasOwn`
 * (`src/providers/openrouter-routing.ts:89`), and the type documents the first as
 * "Exact-model hosted tools" (`src/types.ts:1584`). Sending them through
 * `modelRecordValue` would make the report say a `gpt-oss` entry applies to
 * `gpt-oss:120b` when the adapter will never apply it -- the same divergence this
 * file exists to remove, pointed the other way. A bare index is not the answer
 * either: it walks the prototype chain, which is the bug `modelValue` just fixed.
 * Neither existing primitive is right for these two, so this is the third one.
 */
function exactOwnValue<T>(map: Record<string, T> | undefined, modelId: string): T | undefined {
  return map !== undefined && Object.hasOwn(map, modelId) ? map[modelId] : undefined;
}

const CREDENTIAL_HEADER = /(authorization|api[-_]?key|token|secret|credential|cookie)/i;

function nonCredentialHeaderDigest(
  headers: Record<string, string> | undefined,
  installationSalt: Uint8Array | string,
): string {
  const rows = Object.entries(headers ?? {})
    .filter(([name]) => !CREDENTIAL_HEADER.test(name))
    .map(([name, value]) => [name.toLowerCase().trim(), value] as const)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return localFingerprint("nonCredentialHeaders", rows, installationSalt);
}

function effectiveOpenRouterRouting(effective: OcxProviderConfig, modelId: string) {
  return exactOwnValue(effective.modelOpenRouterRouting, modelId) ?? effective.openRouterRouting;
}

/**
 * Production behavior resolver for route-subject fingerprinting.
 *
 * The caller supplies the already-resolved effective provider config. This is
 * deliberately the same effective config used for routeContext identity so a
 * model wire override cannot disagree with the behavior fingerprint.
 */
export function resolveProductionBehaviorValues(
  config: OcxConfig,
  providerName: string,
  modelId: string,
  effective: OcxProviderConfig,
  installationSalt: Uint8Array | string,
): LabBehaviorValues | null {
  const provider = config.providers[providerName];
  if (!provider || provider.disabled === true) return null;
  const adapter = effective.adapter ?? "openai-responses";
  const upstreamProtocol = upstreamProtocolForAdapter(adapter);
  const registryEntry = PROVIDER_REGISTRY.find(entry => entry.id === providerName);
  const authMode = effective.authMode ?? registryEntry?.authKind ?? "key";
  const reasoningEfforts = modelValue(effective.modelReasoningEfforts, modelId)
    ?? effective.reasoningEfforts
    ?? [];
  const defaultReasoningEffort = modelValue(effective.modelDefaultReasoningEfforts, modelId) ?? null;
  const reasoningEffortMap = modelValue(effective.modelReasoningEffortMap, modelId)
    ?? effective.reasoningEffortMap
    ?? {};
  const openRouterRouting = effectiveOpenRouterRouting(effective, modelId);
  const project = typeof effective.project === "string" && effective.project ? effective.project : null;
  const location = typeof effective.location === "string" && effective.location ? effective.location : null;
  const nativeLocalExec = effective.nativeLocalExec === "on" || effective.unsafeAllowNativeLocalExec === true;
  const fastPolicy = fastPolicyForModel(effective, modelId, providerName, "responses", provider);

  const values: LabBehaviorValues = {
    "wire.adapter": behaviorRow("provider_config", adapter),
    "wire.upstreamProtocol": behaviorRow("provider_config", upstreamProtocol),
    "wire.responsesPath": behaviorRow("provider_config", effective.responsesPath ?? null),
    "wire.commandCodeVersion": behaviorRow("provider_config", effective.commandCodeVersion ?? null),
    "wire.modelSuffixMode": behaviorRow(
      "provider_config",
      effective.modelSuffixBracketStrip === true ? "bracket_strip" : "none",
    ),
    "auth.mode": behaviorRow("provider_config", authMode),
    "auth.transport": behaviorRow(
      "provider_config",
      resolveProviderAuthTransport(adapter, authMode, effective.apiKeyTransport),
    ),
    "responses.stateful": behaviorRow("provider_config", effective.statelessResponses !== true),
    "responses.serviceTier": behaviorRow(
      "provider_config",
      serviceTierSupportFromPolicy(fastPolicy) ?? null,
    ),
    "responses.fastWireKind": behaviorRow(
      "provider_config",
      fastPolicy.fastWire?.kind ?? null,
    ),
    "responses.fastWireValue": behaviorRow(
      "provider_config",
      fastPolicy.fastWire?.canonicalToWire.priority ?? null,
    ),
    "responses.snapshotRepair": behaviorRow("provider_config", effective.responsesSnapshotRepair === true),
    "responses.itemIdRepair": behaviorRow("provider_config", effective.responsesItemIdRepair ?? null),
    "limits.contextWindow": behaviorRow(
      "provider_config",
      modelValue(effective.modelContextWindows, modelId) ?? effective.contextWindow ?? null,
    ),
    "limits.maxInputTokens": behaviorRow(
      "provider_config",
      modelValue(effective.modelMaxInputTokens, modelId) ?? null,
    ),
    "limits.maxOutputTokens": behaviorRow(
      "provider_config",
      modelValue(effective.modelMaxOutputTokens, modelId) ?? effective.defaultMaxOutputTokens ?? null,
    ),
    "modalities.input": behaviorRow(
      "provider_config",
      modelValue(effective.modelInputModalities, modelId) ?? ["text"],
    ),
    "sampling.omitTemperature": behaviorRow("provider_config", includesModel(effective.noTemperatureModels, modelId)),
    "sampling.omitTopP": behaviorRow("provider_config", includesModel(effective.noTopPModels, modelId)),
    "sampling.omitPenalties": behaviorRow("provider_config", includesModel(effective.noPenaltyModels, modelId)),
    "reasoning.supported": behaviorRow(
      "provider_config",
      includesModel(effective.noReasoningModels, modelId)
        ? false
        : reasoningEfforts.length > 0 || Boolean(registryEntry?.reasoningEfforts),
    ),
    "reasoning.efforts": behaviorRow("provider_config", reasoningEfforts),
    "reasoning.defaultEffort": behaviorRow("provider_config", defaultReasoningEffort),
    "reasoning.effortMap": behaviorRow("provider_config", reasoningEffortMap),
    "reasoning.wireFormat": behaviorRow("provider_config", effective.reasoningWireFormat ?? null),
    "reasoning.summaryMode": behaviorRow("provider_config", {
      supported: modelValue(effective.modelSupportsReasoningSummaries, modelId) ?? null,
      delivery: modelValue(effective.modelReasoningSummaryDelivery, modelId) ?? null,
    }),
    "reasoning.replayMode": behaviorRow("provider_config", {
      preserveResponses: effective.preserveResponsesReasoningContent === true,
      preserveContent: includesModel(effective.preserveReasoningContentModels, modelId),
      placeholder: includesModel(effective.requiresReasoningPlaceholderModels, modelId),
    }),
    "reasoning.splitMode": behaviorRow("provider_config", includesModel(effective.reasoningSplitModels, modelId)),
    "reasoning.toggleMode": behaviorRow("provider_config", includesModel(effective.thinkingToggleModels, modelId)),
    "reasoning.budgetMode": behaviorRow("provider_config", includesModel(effective.thinkingBudgetModels, modelId)),
    "tools.choiceRestrictions": behaviorRow(
      "provider_config",
      includesModel(effective.autoToolChoiceOnlyModels, modelId) ? ["auto"] : [],
    ),
    "tools.parallel": behaviorRow(
      "provider_config",
      effective.parallelToolCalls ?? (upstreamProtocol === "openai-chat"),
    ),
    "tools.hostedPreference": behaviorRow("provider_config", {
      tools: exactOwnValue(effective.modelPreferHostedTools, modelId) ?? [],
    }),
    "tools.builtinNameEscaping": behaviorRow("provider_config", effective.escapeBuiltinToolNames === true),
    "cache.forwarding": behaviorRow("provider_config", effective.promptCacheKey === true),
    "cache.retention": behaviorRow("global_config", config.cacheRetention ?? "short"),
    "anthropic.eofPolicy": behaviorRow("provider_config", effective.anthropicEofTolerance === true ? "tolerant" : "strict"),
    "openai-chat.eofPolicy": behaviorRow("provider_config", effective.openaiChatEofTolerance === true ? "tolerant" : "strict"),
    "google.mode": behaviorRow("provider_config", effective.googleMode ?? null),
    "google.projectFingerprint": behaviorRow(
      "provider_config",
      project ? localFingerprint("googleProject", project, installationSalt) : null,
    ),
    "google.locationFingerprint": behaviorRow(
      "provider_config",
      location ? localFingerprint("googleLocation", location, installationSalt) : null,
    ),
    "openrouter.order": behaviorRow("provider_config", openRouterRouting?.order ?? []),
    "openrouter.only": behaviorRow("provider_config", openRouterRouting?.only ?? []),
    "openrouter.allowFallbacks": behaviorRow("provider_config", openRouterRouting?.allowFallbacks ?? null),
    "sidecars.vision": behaviorRow(
      "global_config",
      localFingerprint("visionSidecar", config.visionSidecar ?? null, installationSalt),
    ),
    "sidecars.webSearch": behaviorRow(
      "global_config",
      localFingerprint("webSearchSidecar", config.webSearchSidecar ?? null, installationSalt),
    ),
    "mcp.maxTools": behaviorRow("provider_config", effective.mcpMaxTools ?? null),
    "mcp.maxSchemaBytes": behaviorRow("provider_config", effective.mcpMaxSchemaBytes ?? null),
    "mcp.maxResultBytes": behaviorRow("provider_config", effective.mcpMaxResultBytes ?? null),
    "mcp.nativeLocalExec": behaviorRow("provider_config", nativeLocalExec),
    "runtime.bunVersion": behaviorRow("registry_runtime_default", Bun.version),
    "runtime.platform": behaviorRow("registry_runtime_default", process.platform),
    "runtime.arch": behaviorRow("registry_runtime_default", process.arch),
    "runtime.streamMode": behaviorRow("global_config", config.streamMode ?? "auto"),
    "runtime.fastMode": behaviorRow("global_config", config.fastMode === true),
    "runtime.effortCap": behaviorRow("global_config", config.effortCap ?? null),
    "headers.nonCredentialBehaviorDigest": behaviorRow(
      "provider_config",
      nonCredentialHeaderDigest(effective.headers, installationSalt),
    ),
  };

  return values;
}

export function providerInstanceKey(
  providerName: string,
  effective: OcxProviderConfig,
): string {
  const baseUrl = typeof effective.baseUrl === "string" ? effective.baseUrl.trim() : "";
  const adapter = typeof effective.adapter === "string" ? effective.adapter : "";
  return `${providerName}\0${baseUrl}\0${adapter}`;
}
