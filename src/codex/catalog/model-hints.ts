import { effectiveProviderAlias, effectiveProviderAliasDecision } from "../../providers/default-aliases";
import { initialModelSelectionPending } from "../../providers/initial-model-selection";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { atomicWriteFile, expandUserPath, getConfigDir, websocketsEnabled } from "../../config";
import { resolveProviderApiKey } from "../../providers/key-store";
import { CODEX_CONFIG_PATH, CODEX_MODELS_CACHE_PATH, DEFAULT_CATALOG_PATH, readRootTomlString, resolveCodexConfigPath } from "../paths";
import {
  clearModelCache,
  clearProviderDiscoveryStatus,
  captureModelCacheGeneration,
  DEFAULT_MODEL_CACHE_TTL_MS,
  getFreshCached,
  getStaleCached,
  isModelsFetchCoolingDown,
  isModelCacheGenerationCurrent,
  markModelsFetchFailure,
  markProviderDiscoveryFailed,
  markProviderDiscoveryOk,
  shouldLogDiscoveryFailure,
  setCached,
  type ProviderModelDiscoveryFailure,
} from "../model-cache";
import {
  buildModelsRequest,
  getValidAccessTokenSnapshot,
  observeActiveOAuthAccessToken,
  resolveModelsAuthToken,
  type OAuthActiveTokenObservation,
} from "../../oauth";
import type { OcxConfig, OcxProviderConfig } from "../../types";
import { modelInList } from "../../types";
import { CODEX_REASONING_LEVELS, codexEffortRank, configuredReasoningEfforts, modelRecordValue, sanitizeCodexReasoningEfforts } from "../../reasoning-effort";
import { isModelVisionSidecarConsumer } from "../../vision/eligibility";
import { getModelMetadata, getModelMetadataCaseInsensitive, listModelMetadata, resolveMetadataProvider, type ModelMetadata } from "../../generated/model-metadata";
import { enrichProviderFromRegistry, shouldCaseFoldMetadataModelId } from "../../providers/derive";
import {
  captureFastPolicyAuthority,
  fastPolicyForModel,
  serviceTierSupportFromPolicy,
} from "../../providers/service-tier";
import type { FastPolicyAuthority } from "../../providers/fastwire";
import { effectiveGoogleMode, getProviderRegistryEntry, providerMatchesRegistryTransport, registryEntryForProviderDestination } from "../../providers/registry";
import { parseAntigravityAvailableModels, registerAntigravityDiscoveredWireModels } from "../../providers/antigravity-models";
import { applyProviderContextCap, providerContextCap, resolveUnknownRoutedContextWindow } from "../../providers/context-cap";
import { clampAutoCompactTokenLimit } from "../../providers/auto-compact-budget";
import { effectiveModelAliases } from "../../providers/default-aliases";
import { routedSlug, slugEquals, slugEquivalenceKey, slugsEquivalent } from "../../providers/slug-codec";
import { CODEX_GPT5_IDENTITY_LINE } from "../../adapters/identity";
import { filterCursorConfiguredModelsByLiveDiscovery } from "../../adapters/cursor/discovery";
import { fetchCursorUsableModels } from "../../adapters/cursor/live-models";
import { recordLiveCursorClaudeModels, recordLiveCursorMaxModeModels } from "../../adapters/cursor/catalog";
import { fetchQoderModels } from "../../adapters/qoder/live-models";
import { resolveQoderProfile } from "../../adapters/qoder/profiles";
import { fetchDevinUsableModels } from "../../adapters/devin/live-models";
import { isCanonicalOpenAiForwardProvider, OPENAI_API_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import {
  COMBO_NAMESPACE,
  comboModelId,
  getCombo,
  listComboIds,
  quotaInactiveReason,
  targetKey,
} from "../../combos";
import type { NormalizedComboConfig } from "../../combos/types";
import {
  ProviderOutboundPolicyError,
  providerOutboundGet,
  providerOutboundPost,
  providerRedirectError,
} from "../../lib/provider-outbound";
import { redactSecretString } from "../../lib/redact";
import {
  extractProviderModelItems,
  isRegistryModelDiscoveryUrl,
  readBoundedDiscoveryJson,
  resolveProviderModelDiscovery,
  type ModelDiscoveryResponseFailure,
  type ProviderModelsApiItem,
  type ResolvedProviderModelDiscovery,
} from "../../providers/model-discovery";
import { extractGoogleAiStudioModelItems } from "../../providers/google-ai-studio-model-discovery";
import { applyConfiguredHeadersLast, fetchOllamaShowEnrichment, ollamaShowEnrichable } from "../../providers/ollama-show";
import upstreamModelsSnapshot from "../data/upstream-models.json";
import { createAdmissionGate, ResourceAdmissionError, type AdmissionMetrics } from "../../lib/admission";
import { CODEX_CUSTOM_MODEL_CATALOG_KIND, JAWCODE_CATALOG_AUGMENT_PROVIDERS, catalogModelSlug, shouldExposeRoutedModel } from "./parsing";
import type { CatalogModel } from "./parsing";
import { disabledNativeSlugs, hasComboTargets, hasNativeOpenAiCapabilityMetadata, NATIVE_GPT56_MAX_INPUT_TOKENS, nativeContextLimits, nativeOpenAiCapabilityDisplayName, nativeDefaultReasoningEffort, nativeInputModalities, nativeOpenAiAutoCompactTokenLimit, nativeOpenAiContextWindow, nativeOpenAiMaxInputTokens, nativeOpenAiMaxOutputTokens, nativeOpenAiSlugs, nativeParallelToolCalls, nativeReasoningEfforts } from "./metadata";
import { deriveComboCatalogModel, normalizedOpenAiApiSignature, openAiApiCollisionWarnings, replaceLastComboCatalogOmissions, warnUncataloguedComboOnce } from "./aggregation";
import type { ComboCatalogOmission } from "./aggregation";
import { clampObservedModelLimits, resolveModelPolicy } from "../../providers/resolved-model-policy";
import type { CatalogGatherProviderAuthEvidence } from "./filesystem-evidence";
import type {
  CatalogAdmissionSnapshot,
  CatalogDiscoveryPolicyField,
  CatalogGatherAuthorityIdentity,
  CatalogProviderDiscoveryPolicySnapshot,
  CatalogProcessLocalEvidence,
  CatalogSourceEvidence,
  CatalogTrustedOpenAiApiPolicySnapshot,
} from "../convergence-types";


/**
 * Fill the registry seed's per-model numeric capability maps beneath the provider's own
 * values, mutating `prov` in place. The merge is per key — an operator's entry always
 * wins; a model the persisted map never mentions picks up its seed value — matching
 * `mergeRecordFill` in src/router.ts exactly.
 *
 * Routing already performs this fill at resolve time (routedProviderConfig in
 * src/router.ts) and the catalog did not, and that divergence is #4570:
 * zhipu-bigmodel-coding/glm-5.3-flash reached the live catalog with correct modalities
 * but no context window, because an install persisted before Flash joined the seed map
 * held a truthy partial `modelContextWindows` that shadowed the whole seed.
 *
 * This lives here and not in enrichProviderFromRegistry because enrichment output is
 * persisted on a management POST, and #1409 (pinned by
 * tests/server/management-provider-validation.test.ts) requires that a save never write
 * registry seed keys into the operator's config. The gather clone is detached and
 * frozen, never saved, so the catalog can see the seed without the config gaining it.
 */
export function applyRegistryCapabilitySeedFill(name: string, prov: OcxProviderConfig): void {
  // router.ts resolves the canonical OpenAI API provider's token maps with
  // mergePositiveNumberCaps (user values cap the seed rather than replace it), so a
  // plain fill here would give that one provider catalog semantics routing never has.
  if (name === OPENAI_API_PROVIDER_ID) return;
  if (!providerMatchesRegistryTransport(name, prov)) return;
  const entry = getProviderRegistryEntry(name);
  if (!entry) return;
  if (entry.modelContextWindows || prov.modelContextWindows) {
    prov.modelContextWindows = { ...(entry.modelContextWindows ?? {}), ...(prov.modelContextWindows ?? {}) };
  }
  if (entry.modelMaxOutputTokens || prov.modelMaxOutputTokens) {
    prov.modelMaxOutputTokens = { ...(entry.modelMaxOutputTokens ?? {}), ...(prov.modelMaxOutputTokens ?? {}) };
  }
}
const NUMERIC_MODEL_ID_SEGMENT = /^\d+$/;

/**
 * Resolve an unknown Claude point release or date pin from the nearest configured
 * family row. Only numeric tail segments are removed so unrelated model families
 * cannot inherit one another's limits.
 */
function anthropicFamilyContextWindow(
  record: Record<string, number> | undefined,
  id: string,
): number | undefined {
  if (!record || !id.toLowerCase().startsWith("claude-")) return undefined;
  let candidate = id;
  while (true) {
    const cut = candidate.lastIndexOf("-");
    if (cut <= 0 || !NUMERIC_MODEL_ID_SEGMENT.test(candidate.slice(cut + 1))) return undefined;
    candidate = candidate.slice(0, cut);
    const value = modelRecordValue(record, candidate);
    if (typeof value === "number" && value > 0) return value;
  }
}

/**
 * Resolve the configured context window in exact-model, Anthropic numeric-family,
 * then provider-wide order. Return undefined when the selected value is not positive.
 */
export function configuredContextWindow(prov: OcxProviderConfig, id: string): number | undefined {
  const configured = modelRecordValue(prov.modelContextWindows, id)
    ?? (prov.adapter === "anthropic" ? anthropicFamilyContextWindow(prov.modelContextWindows, id) : undefined)
    ?? prov.contextWindow;
  return typeof configured === "number" && configured > 0 ? configured : undefined;
}

export function configuredInputModalities(prov: OcxProviderConfig, id: string): string[] | undefined {
  const declared = Object.hasOwn(prov.modelCapabilities ?? {}, id)
    ? prov.modelCapabilities?.[id]?.inputModalities : undefined;
  const modalities = declared ?? modelRecordValue(prov.modelInputModalities, id);
  return Array.isArray(modalities) && modalities.length > 0 ? [...modalities] : undefined;
}

/** Exact display-only override for one provider-native model id. */
export function configuredModelDisplayName(
  prov: OcxProviderConfig,
  id: string,
): string | undefined {
  if (!prov.modelDisplayNames || !Object.hasOwn(prov.modelDisplayNames, id)) return undefined;
  const value = prov.modelDisplayNames[id];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function configuredMaxInputTokens(prov: OcxProviderConfig, id: string): number | undefined {
  const configured = modelRecordValue(prov.modelMaxInputTokens, id);
  return typeof configured === "number" && configured > 0 ? configured : undefined;
}

function generatedMaxOutputTokens(
  providerName: string,
  id: string,
  metadataId = id,
  metadataModelIdCaseFold?: boolean,
): number | undefined {
  const metadataProvider = providerName === OPENAI_API_PROVIDER_ID || providerName === OPENAI_CODEX_PROVIDER_ID
    ? "openai"
    : resolveMetadataProvider(providerName);
  if (!metadataProvider) return undefined;
  const metadata = getModelMetadata(metadataProvider, metadataId)
    ?? ((metadataModelIdCaseFold ?? (providerName === OPENAI_API_PROVIDER_ID || providerName === OPENAI_CODEX_PROVIDER_ID
      ? false
      : shouldCaseFoldMetadataModelId(providerName)))
      ? getModelMetadataCaseInsensitive(metadataProvider, metadataId)
      : undefined);
  return positiveSafeInteger(metadata?.maxTokens);
}

export function routedMaxOutputTokens(
  providerName: string,
  provider: OcxProviderConfig,
  model: CatalogModel,
  metadataId = model.id,
  metadataModelIdCaseFold?: boolean,
): number | undefined {
  const discovered = positiveSafeInteger(model.maxOutputTokens);
  const generated = generatedMaxOutputTokens(providerName, model.id, metadataId, metadataModelIdCaseFold);
  const configured = positiveSafeInteger(
    modelRecordValue(provider.modelMaxOutputTokens, model.id),
  );
  const authoritative = discovered ?? generated;
  if (configured === undefined) return authoritative;
  return authoritative === undefined
    ? configured
    : Math.min(authoritative, configured);
}

export function configuredAutoCompactTokenLimit(
  prov: OcxProviderConfig | undefined,
  id: string,
): number | undefined {
  if (!prov) return undefined;
  const configured = modelRecordValue(prov.modelAutoCompactTokenLimits, id);
  return typeof configured === "number" && Number.isSafeInteger(configured) && configured > 0
    ? configured
    : undefined;
}

export function configuredReasoningSummarySupport(prov: OcxProviderConfig | undefined, id: string): boolean | undefined {
  if (!prov) return undefined;
  const explicit = modelRecordValue(prov.modelSupportsReasoningSummaries, id);
  if (explicit !== undefined) return explicit;
  return modelRecordValue(prov.modelReasoningSummaryDelivery, id) !== undefined ? true : undefined;
}

export function applyProviderConfigHints(
  name: string,
  prov: OcxProviderConfig,
  model: CatalogModel,
  providerCap?: number,
  metadataModelIdCaseFold?: boolean,
  effectiveAlias?: string | null,
): CatalogModel {
  const staticPolicy = resolveModelPolicy({
    providerName: name,
    modelId: model.id,
    provider: prov,
    transportMatchedRegistry: false,
    modelCapabilities: prov.modelCapabilities?.[model.id],
    ...(prov.authMode ? { effectiveAuth: { authMode: prov.authMode } } : {}),
    ...(effectiveAlias !== undefined ? { effectiveAlias } : {}),
  });
  const displayName = configuredModelDisplayName(prov, model.id);
  // The alias decision is resolved once at flight admission (captureProviderGather) and threaded
  // through as `effectiveAlias`. Re-deriving it here would read PROVIDER_REGISTRY after admission,
  // which is exactly the authority leak tests/codex-integration/codex-gather-authority.test.ts
  // forbids: a flight must not consult the live registry once its transport has been captured.
  // When no decision was threaded in, carry whatever the row already resolved to instead.
  const providerAlias = typeof effectiveAlias === "string" || effectiveAlias === null
    ? effectiveAlias
    : model.providerAlias;
  const configuredCap = staticPolicy.model.contextWindow ?? configuredContextWindow(prov, model.id);
  const configuredMaxInput = staticPolicy.model.maxInputTokens;
  const maxOutputTokens = routedMaxOutputTokens(name, prov, model, model.id, metadataModelIdCaseFold);
  const configuredAutoCompact = configuredAutoCompactTokenLimit(prov, model.id);
  // The resolver owns exact capability precedence and legacy exact/colon-family/case-fold fallback.
  // Removing an exact capability row therefore returns this projection to legacy-map inference.
  let inputModalities = staticPolicy.model.inputModalities
    ? [...staticPolicy.model.inputModalities]
    : undefined;
  // The shared vision-sidecar consumer predicate keeps catalog advertisement and request-time
  // planning aligned. The catalog must still advertise image input — the Codex app
  // gates attachments client-side on input_modalities, and a text-only entry would block images
  // before the sidecar ever runs ("This model does not support image inputs"). Discovery-derived
  // text-only rows stay untouched: the runtime predicate only reads these two config sources, so
  // it would not convert those.
  const sidecarCovered = isModelVisionSidecarConsumer(prov, model.id);
  if (sidecarCovered) {
    const base = inputModalities ?? model.inputModalities ?? ["text"];
    inputModalities = base.includes("image") ? [...base] : [...base, "image"];
  }
  const reasoningEfforts = configuredReasoningEfforts(prov, model.id);
  const suppressSyntheticMax = modelRecordValue(prov.modelSuppressSyntheticMax, model.id) === true;
  const defaultReasoningEffort = staticPolicy.model.defaultReasoningEffort ?? model.defaultReasoningEffort;
  const supportsReasoningSummaries = staticPolicy.model.supportsReasoningSummaries;
  const supportsVerbosity = staticPolicy.model.supportsVerbosity;
  const fastPolicy = fastPolicyForModel(prov, model.id, name);
  // Frozen gather providers retain the captured Fast authority. That late/captured eligibility
  // owns catalog publication, including an explicit provider-level false.
  const supportsServiceTier = serviceTierSupportFromPolicy(fastPolicy);
  const {
    supportsServiceTier: _staleServiceTier,
    fastTierDescription: _staleFastTierDescription,
    providerAlias: _staleProviderAlias,
    suppressSyntheticMax: _staleSuppressSyntheticMax,
    ...modelWithoutServiceTier
  } = model;
  // 已发现窗口只允许被配置值压低；缺窗口时，已开的 Context cap 就是实际窗口。
  const discoveredWindow = typeof model.contextWindow === "number" && model.contextWindow > 0
    ? model.contextWindow
    : undefined;
  const projectedLimits = clampObservedModelLimits(staticPolicy.model, {
    ...(discoveredWindow !== undefined ? { contextWindow: discoveredWindow } : {}),
    ...(typeof model.maxInputTokens === "number" && model.maxInputTokens > 0 ? { maxInputTokens: model.maxInputTokens } : {}),
  });
  const hintedWindow = projectedLimits.contextWindow
    ?? (providerCap !== undefined ? resolveUnknownRoutedContextWindow(providerCap) : undefined);
  const hinted = {
    ...modelWithoutServiceTier,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(providerAlias !== undefined ? { providerAlias } : {}),
    ...(hintedWindow !== undefined ? { contextWindow: hintedWindow } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
    ...(suppressSyntheticMax ? { suppressSyntheticMax: true } : {}),
    ...(configuredMaxInput !== undefined
      ? {
        maxInputTokens: projectedLimits.maxInputTokens ?? configuredMaxInput,
      }
      : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(typeof supportsReasoningSummaries === "boolean" ? { supportsReasoningSummaries } : {}),
    ...(typeof supportsVerbosity === "boolean" ? { supportsVerbosity } : {}),
    ...(typeof supportsServiceTier === "boolean" ? { supportsServiceTier } : {}),
    ...(supportsServiceTier === true && fastPolicy.fastTierDescription !== undefined
      ? { fastTierDescription: fastPolicy.fastTierDescription }
      : {}),
    // Default-on for openai-chat providers (explicit false opts out); other adapters
    // advertise only on explicit opt-in.
    ...(prov.parallelToolCalls === true || (prov.adapter === "openai-chat" && prov.parallelToolCalls !== false)
      ? { parallelToolCalls: true }
      : {}),
    ...(prov.codexToolMode !== undefined ? { codexToolMode: prov.codexToolMode } : {}),
  };
  const capped = applyProviderContextCap(hinted.contextWindow, providerCap);
  const withCap = providerCap !== undefined
    ? capped !== hinted.contextWindow
      ? { ...hinted, contextWindow: capped, contextCap: providerCap, contextCapped: true }
      : { ...hinted, contextCap: providerCap, contextCapped: false }
    : hinted;
  const contextWindow = typeof withCap.contextWindow === "number" && withCap.contextWindow > 0
    ? withCap.contextWindow
    : undefined;
  const boundedMaxInput = typeof withCap.maxInputTokens === "number" && withCap.maxInputTokens > 0
    ? (contextWindow !== undefined ? Math.min(withCap.maxInputTokens, contextWindow) : withCap.maxInputTokens)
    : undefined;
  const withHardBounds = boundedMaxInput !== undefined && boundedMaxInput !== withCap.maxInputTokens
    ? { ...withCap, maxInputTokens: boundedMaxInput }
    : withCap;
  const softCandidates = [model.autoCompactTokenLimit, configuredAutoCompact]
    .filter((value): value is number => typeof value === "number" && value > 0);
  if (contextWindow === undefined || softCandidates.length === 0) return withHardBounds;
  return {
    ...withHardBounds,
    autoCompactTokenLimit: clampAutoCompactTokenLimit(
      contextWindow,
      boundedMaxInput,
      Math.min(...softCandidates),
    ),
  };
}

export function catalogHintsFromProviderConfig(
  name: string,
  prov: OcxProviderConfig,
  id: string,
  contextCap?: number,
  metadataModelIdCaseFold?: boolean,
  effectiveAlias?: string | null,
): Partial<CatalogModel> {
  const hinted = applyProviderConfigHints(name, prov, { id, provider: name }, contextCap, metadataModelIdCaseFold, effectiveAlias);
  const { provider: _provider, id: _id, ...hints } = hinted;
  return hints;
}

export function applyConfigHintsToCachedModels(
  name: string,
  prov: OcxProviderConfig,
  models: CatalogModel[],
  contextCap?: number,
  metadataModelIdCaseFold?: boolean,
  effectiveAlias?: string | null,
): CatalogModel[] {
  return models.map(model => applyProviderConfigHints(name, prov, model, contextCap, metadataModelIdCaseFold, effectiveAlias));
}

/** Catalog slugs whose configured model must not gain a missing synthetic max rung. */
export function suppressedSyntheticMaxCatalogSlugs(
  config: Pick<OcxConfig, "providers">,
  models: readonly CatalogModel[],
  observedEntries: readonly { slug?: unknown }[] = [],
): ReadonlySet<string> {
  const slugs = new Set(models
    .filter(model => model.suppressSyntheticMax === true)
    .map(catalogModelSlug));
  for (const [provider, providerConfig] of Object.entries(config.providers)) {
    const configured = providerConfig.modelSuppressSyntheticMax ?? {};
    const encoded = Object.fromEntries(Object.entries(configured)
      .map(([modelId, suppress]) => [routedSlug(provider, modelId).slice(provider.length + 1), suppress]));
    for (const [modelId, suppress] of Object.entries(configured)) {
      if (suppress === true) slugs.add(routedSlug(provider, modelId));
    }
    for (const entry of observedEntries) {
      const slug = typeof entry.slug === "string" ? entry.slug : "";
      if (!slug.startsWith(`${provider}/`)) continue;
      if (modelRecordValue(encoded, slug.slice(provider.length + 1)) === true) slugs.add(slug);
    }
  }
  return slugs;
}
export const QUIET_AUTHORITATIVE_CATALOG_PROVIDERS = new Set(["kimi", "xai"]);

export const CALLABLE_CONFIGURED_COMPATIBILITY_MODELS: Readonly<Record<string, ReadonlySet<string>>> = {
  kimi: new Set([
    "k3[1m]",
    "kimi-k2.7-code",
    "kimi-k2.7-code-highspeed",
    "kimi-k2.6",
    "kimi-k2.5",
  ]),
  xai: new Set([
    "grok-4.3",
    "grok-4.20-multi-agent-0309",
    "grok-4.20-0309-reasoning",
    "grok-4.20-0309-non-reasoning",
    "grok-build-0.1",
    "grok-composer-2.5-fast",
  ]),
};
/**
 * Z.AI and Neuralwatt advertise GLM reasoning as a bare boolean, which would otherwise
 * collapse to the four-tier default ladder that omits `max`. These two helpers name the
 * ladder each GLM generation actually honours on the wire.
 */
/** GLM-5.2 and its 1M alias: the full five-tier ladder including `max`. */
export function isGlm52ModelId(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  return normalized === "glm-5.2" || normalized === "glm-5.2[1m]";
}
/**
 * GLM-5.3 and its 1M alias. 260814: docs.z.ai/devpack/latest-model folds every incoming
 * effort into three effective tiers (low/minimal/light -> low, medium/high -> high,
 * xhigh/max/ultra -> max), so a boolean capability must not be expanded to five rows.
 */
export function isGlm53ModelId(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  return normalized === "glm-5.3" || normalized === "glm-5.3[1m]";
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const MODEL_DISCOVERY_METADATA_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export function positiveSafeInteger(...values: unknown[]): number | undefined {
  return values.find(value => typeof value === "number" && Number.isSafeInteger(value) && value > 0) as number | undefined;
}

function normalizedMetadataString(raw: string, maxLength: number): string | undefined {
  if (raw.length > maxLength * 4 || MODEL_DISCOVERY_METADATA_CONTROL_CHARS.test(raw)) return undefined;
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, "-").slice(0, maxLength);
  return normalized || undefined;
}

function normalizedStringList(value: unknown, maxItems = 32, maxLength = 64): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const maxInspectedItems = Math.max(maxItems * 8, maxItems);
  for (let i = 0; i < value.length && i < maxInspectedItems; i += 1) {
    const raw = value[i];
    if (typeof raw !== "string") continue;
    const normalized = normalizedMetadataString(raw, maxLength);
    if (normalized && !out.includes(normalized)) out.push(normalized);
    if (out.length >= maxItems) break;
  }
  return out.length > 0 ? out : undefined;
}

export function modelCapabilities(item: ProviderModelsApiItem): string[] | undefined {
  const metadata = plainRecord(item.metadata);
  const metadataCapabilities = metadata?.capabilities;
  const capabilityRecord = plainRecord(metadataCapabilities)
    ?? plainRecord(item.capabilities)
    ?? plainRecord(item.features);
  const out = new Set<string>();
  for (const list of [item.capabilities, item.features, item.supported_features, metadataCapabilities]) {
    for (const capability of normalizedStringList(list) ?? []) out.add(capability);
  }
  const capabilityFields = capabilityRecord ?? {};
  let inspectedCapabilityFields = 0;
  for (const key in capabilityFields) {
    if (!Object.hasOwn(capabilityFields, key)) continue;
    inspectedCapabilityFields += 1;
    if (inspectedCapabilityFields > 256 || out.size >= 32) break;
    if (capabilityFields[key] === true) {
      const normalized = normalizedMetadataString(key, 64);
      if (normalized) out.add(normalized);
    }
  }
  for (const field of ["supports_tools", "supports_tool_calling", "supports_function_calling"] as const) {
    if (item[field] === true) out.add("tools");
  }
  for (const field of ["supports_reasoning", "reasoning"] as const) {
    if (item[field] === true) out.add("reasoning");
  }
  return out.size > 0 ? [...out].filter(Boolean).slice(0, 32) : undefined;
}

export function modelInputModalities(
  item: ProviderModelsApiItem,
  capabilities: readonly string[] | undefined,
): string[] | undefined {
  const metadata = plainRecord(item.metadata);
  const capabilityRecord = plainRecord(metadata?.capabilities)
    ?? plainRecord(item.capabilities)
    ?? plainRecord(item.features);
  const explicit = normalizedStringList(
    item.input_modalities
      ?? item.modalities
      ?? metadata?.input_modalities
      ?? capabilityRecord?.input_modalities
      ?? plainRecord(item.architecture)?.input_modalities,
    8,
    24,
  )?.filter(value => (
    // Codex parses `input_modalities` as a closed enum of text | image | audio. A provider that
    // advertises anything else (zenmux reports "video") must not reach the catalog: Codex rejects
    // the whole file, so plugins, apps and MCP servers all stop loading over one model's metadata.
    value === "text" || value === "image" || value === "audio"
  ));
  if (explicit && explicit.length > 0) return explicit;
  const architecture = plainRecord(item.architecture);
  const architectureModality = typeof architecture?.modality === "string"
    ? normalizedMetadataString(architecture.modality, 64)
    : undefined;
  if (architectureModality?.includes("->")) {
    const [rawInput = ""] = architectureModality.split("->");
    const inferred = rawInput
      .split("+")
      .filter(value => value === "text" || value === "image" || value === "audio");
    if (inferred.length > 0) return [...new Set(inferred)];
  }
  // GitHub Copilot nests vision support one level down as `capabilities.supports.vision`, so the
  // flat read alone finds nothing and every Copilot model falls through to `["text"]` — Codex then
  // refuses image attachments on models that accept them (#2941). Precedence is by specificity:
  // a flat boolean is authoritative when present, the nested boolean is consulted only otherwise,
  // and a non-boolean at either level decides NOTHING so the signals below still apply. Two things
  // this ordering deliberately avoids: a deny-wins rule across both levels would flip a provider
  // reporting flat `true` with nested `false` from image-capable to text-only, changing behaviour
  // that predates Copilot support; and a truthy test would let the string `"no"` advertise image
  // input. The payload also carries a SECOND `vision` key under `limits` holding an image count,
  // which is why this reads one exact path instead of searching `capabilities` for a vision-ish key.
  const nestedSupports = plainRecord(capabilityRecord?.supports);
  const explicitVisionSupport = typeof capabilityRecord?.vision === "boolean"
    ? capabilityRecord.vision
    : typeof nestedSupports?.vision === "boolean"
      ? nestedSupports.vision
      : undefined;
  if (explicitVisionSupport === false) return ["text"];
  if (explicitVisionSupport === true || capabilities?.some(value => (
    value === "vision" || value === "image-input" || value === "image_input"
    // llama.cpp and Ollama-compatible servers report vision as "multimodal" —
    // it is the only image signal those servers emit (#1797). Mapped to the
    // closed `text|image` enum rather than passed through: an out-of-enum
    // modality makes Codex reject the entire catalog file.
    || value === "multimodal"
  ))) {
    return ["text", "image"];
  }
  return undefined;
}

/**
 * A per-token rate exactly as a /models row publishes it, or undefined when the value is not a
 * usable non-negative number. Providers ship these both as JSON numbers and as decimal strings —
 * OpenRouter encodes free as the string `"0.00000000"` — so both shapes are accepted and nothing
 * else is. The explicit numeric-shape test has to run BEFORE any coercion: `Number("")` and
 * `Number(" ")` are both 0 and `Number(true)` is 1, so a bare `Number(value)` would classify a
 * row with an empty price string as free.
 */
const DISCOVERED_PRICING_RATE_PATTERN = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

function discoveredPricingRate(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && DISCOVERED_PRICING_RATE_PATTERN.test(value.trim())
      ? Number(value.trim())
      : undefined;
  if (numeric === undefined || !Number.isFinite(numeric) || numeric < 0) return undefined;
  return numeric;
}

/**
 * Cost class for one discovered row, read from the provider's own `pricing` object (#3666).
 *
 * Fail closed. Any positive numeric component proves the model is paid. Calling it free requires
 * a complete prompt/completion pair and every published pricing component to be a non-negative
 * numeric zero; an unsupported component is "unknown" because it may describe another charge.
 * Showing a paid model under a Free filter spends the user's money, while hiding a free one costs
 * a click.
 *
 * Two things that look like evidence and are not. A `:free` id suffix is an OpenRouter naming
 * convention, not a price — Nous ships `:free` slugs on a provider whose `freeTier` is false on
 * purpose. And the operator's own `modelCosts` overlay is an estimate they typed, not something
 * the provider published, so a zeroed overlay never reaches this field either.
 *
 * Classification is on numeric zero and never on a unit conversion: OpenRouter quotes USD per
 * token while the cost overlays and the jawcode bundle quote per 1M, and zero is zero in both.
 */
export function discoveredPricingStatus(item: ProviderModelsApiItem): "free" | "paid" | "unknown" {
  const pricing = plainRecord(item.pricing) ?? plainRecord(plainRecord(item.metadata)?.pricing);
  if (!pricing) return "unknown";
  const rates = Object.values(pricing).map(discoveredPricingRate);
  if (rates.some(rate => rate !== undefined && rate > 0)) return "paid";
  if (rates.some(rate => rate === undefined)) return "unknown";
  const prompt = discoveredPricingRate(pricing.prompt ?? pricing.input);
  const completion = discoveredPricingRate(pricing.completion ?? pricing.output);
  if (prompt === undefined || completion === undefined) return "unknown";
  return "free";
}

export function catalogHintsFromModelsApiItem(providerName: string, item: ProviderModelsApiItem): Partial<CatalogModel> {
  const metadata = plainRecord(item.metadata);
  const capabilityRecord = plainRecord(metadata?.capabilities) ?? plainRecord(item.capabilities);
  const limits = plainRecord(metadata?.limits);
  const capabilityLimits = plainRecord(plainRecord(item.capabilities)?.limits);
  const contextWindow =
    positiveSafeInteger(
      limits?.max_context_length,
      // GitHub Copilot reports the live context window here instead of in the metadata or
      // top-level fields used by other OpenAI-compatible catalogs (#3156). Keep the existing
      // metadata field authoritative when both are present: adding this provider-specific
      // fallback must not change previously recognized providers.
      capabilityLimits?.max_context_window_tokens,
      metadata?.context_length,
      item.context_length,
      item.context_size,
      item.max_model_len,
      item.max_context_length,
      // llama.cpp reports the served context under `meta`: `n_ctx` is what the
      // server was actually started with, `n_ctx_train` the model's trained
      // maximum. Prefer the served value — routing must not promise a window the
      // running server will refuse. Both come LAST so no provider already
      // supplying a recognized field changes behavior (#1797).
      plainRecord(item.meta)?.n_ctx,
      plainRecord(item.meta)?.n_ctx_train,
      // A chained OpenCodex hub (and other re-serving gateways) reports the per-model
      // window on the same capability record this function already reads for
      // `max_output_tokens` below (#4032). Without it every routed row fell through to
      // the 128k compatibility floor in parsing.ts while local forward rows kept their
      // real values. Appended after the recognized fields for the same reason as the
      // llama.cpp entries above: no provider that already resolves changes behavior.
      capabilityRecord?.context_length,
    );
  const maxInputTokens = positiveSafeInteger(limits?.max_input_tokens, item.max_input_tokens);
  const maxOutputTokens = positiveSafeInteger(
    capabilityRecord?.max_output_tokens,
    limits?.max_output_tokens,
    metadata?.max_output_tokens,
    item.max_output_tokens,
  );
  // Some OpenAI-compatible catalogs expose the selectable ladder under
  // `reasoning_parameters.efforts` instead of the older `reasoning_efforts` key.
  // Treat both as model metadata: otherwise a valid upstream capability disappears
  // before client exporters (including omp) can advertise it.
  const reasoningParameters = plainRecord(item.reasoning_parameters)
    ?? plainRecord(metadata?.reasoning_parameters)
    ?? plainRecord(capabilityRecord?.reasoning_parameters);
  const rawReasoningEfforts = capabilityRecord?.reasoning_effort
    ?? item.reasoning_efforts
    ?? reasoningParameters?.efforts;
  const listedReasoningEfforts = normalizedStringList(rawReasoningEfforts, 8, 24);
  const reasoningEfforts = listedReasoningEfforts
    ? sanitizeCodexReasoningEfforts(listedReasoningEfforts)
    : typeof rawReasoningEfforts === "boolean"
      ? (rawReasoningEfforts
        ? ((providerName === "neuralwatt" || providerName === "zai") && isGlm53ModelId(item.id)
          ? ["low", "high", "max"]
          : (providerName === "neuralwatt" || providerName === "zai") && isGlm52ModelId(item.id)
            ? ["low", "medium", "high", "xhigh", "max"]
            : ["low", "medium", "high", "xhigh"])
        : [])
      : undefined;
  const capabilities = modelCapabilities(item);
  const inputModalities = modelInputModalities(item, capabilities);
  const pricingStatus = discoveredPricingStatus(item);
  return {
    ...(contextWindow && contextWindow > 0 ? { contextWindow } : {}),
    ...(maxInputTokens && maxInputTokens > 0 ? { maxInputTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(capabilities ? { capabilities } : {}),
    // Omitted when the classification is "unknown", following this function's existing
    // contract that an unknown property is absent rather than present-and-empty. Callers
    // that need to tell "provider published no prices" from "this build does not classify"
    // call discoveredPricingStatus directly.
    ...(pricingStatus !== "unknown" ? { pricingStatus } : {}),
  };
}

export function boundedOwnedBy(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return undefined;
  if (MODEL_DISCOVERY_METADATA_CONTROL_CHARS.test(value)) return undefined;
  return value;
}
