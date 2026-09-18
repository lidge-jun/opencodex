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
import { applyProviderConfigHints, configuredAutoCompactTokenLimit, positiveSafeInteger } from "./model-hints";

/** Model ids each provider must retain for combo catalog derivation (OCX-111). */
export function configuredComboTargetModelsByProvider(
  config: Pick<OcxConfig, "combos">,
): Map<string, ReadonlySet<string>> {
  const byProvider = new Map<string, Set<string>>();
  for (const id of listComboIds(config)) {
    const combo = getCombo(config, id);
    if (!combo) continue;
    for (const target of combo.targets) {
      let models = byProvider.get(target.provider);
      if (!models) {
        models = new Set();
        byProvider.set(target.provider, models);
      }
      models.add(target.model);
    }
  }
  return byProvider;
}
/**
 * Last-resort context window for combo member synthesis when discovery,
 * provider config, and an enabled Context cap all omit one. Matches the
 * catalog entry default in `normalizeRoutedCatalogEntry` so incomplete live
 * rows still catalog. An enabled Context cap is the operator-facing window,
 * not a clamp on this placeholder.
 */
const COMBO_MEMBER_CONTEXT_FALLBACK = 128_000;

interface ComboCatalogMemberFallback {
  readonly contextWindow?: number;
  /** Input ceiling when it is lower than the window (native GPT-5.6: 922k under 1.05M). */
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly autoCompactTokenLimit?: number;
  readonly inputModalities?: readonly string[];
  readonly reasoningEfforts?: readonly string[];
}

/**
 * Ladder advertised for a combo member whose vendor metadata says it reasons but
 * carries no explicit ladder (Claude, Grok). Codex needs a non-empty ladder to show
 * the effort control; the routed adapters clamp to the real upstream top rung.
 */
const ROUTED_COMBO_MEMBER_REASONING_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Vendor-table lookup tolerant of point releases and date pins. Configured combo
 * targets often name a variant the table does not carry (`claude-fable-5-1`,
 * `claude-opus-4-5-20251101`); the base family row still describes its modality
 * and reasoning capability, so fall back to it before giving up.
 */
function comboMemberVendorMetadata(provider: string, modelId: string): ModelMetadata | undefined {
  const exact = getModelMetadataCaseInsensitive(provider, modelId);
  if (exact) return exact;
  let candidate = modelId.replace(/\[[^\]]*\]$/, "");
  while (true) {
    const trimmed = candidate.replace(/-\d+$/, "");
    if (trimmed === candidate || !trimmed.includes("-")) return undefined;
    const hit = getModelMetadataCaseInsensitive(provider, trimmed);
    if (hit) return hit;
    candidate = trimmed;
  }
}

/**
 * Combo members are usually thin discovery rows (id + context window). Without a
 * capability source the combo intersection collapses to text-only / no effort ladder,
 * and the Codex app then refuses image attachments and hides the effort picker for
 * every Claude combo. The generated vendor table knows both, so use it as the
 * last-resort fallback when the caller supplied none.
 *
 * `ModelMetadata.maxTokens` is the OUTPUT ceiling, so it fills `maxOutputTokens`.
 * Mapping it onto `maxInputTokens` would be read by the combo intersection
 * (`aggregation.ts` `Math.min` over member input ceilings) as a 128k input limit and
 * shrink a 1M Claude combo window to 128k, taking autoCompactTokenLimit down with it.
 */
function vendorMetadataComboFallback(target: { provider: string; model: string }): ComboCatalogMemberFallback | undefined {
  const metadataProvider = resolveMetadataProvider(target.provider);
  // Custom OpenAI-compatible routes commonly retain the canonical OpenAI model id
  // while using a provider name that has no metadata alias. Reuse only its effort
  // ladder below; context/modality rows remain provider-owned.
  const metadata = metadataProvider
    ? comboMemberVendorMetadata(metadataProvider, target.model)
    : comboMemberVendorMetadata("openai", target.model);
  if (!metadata) return undefined;
  return {
    ...(metadataProvider && typeof metadata.contextWindow === "number" && metadata.contextWindow > 0
      ? { contextWindow: metadata.contextWindow }
      : {}),
    ...(metadataProvider && typeof metadata.maxTokens === "number" && metadata.maxTokens > 0
      ? { maxOutputTokens: metadata.maxTokens }
      : {}),
    ...(metadataProvider && Array.isArray(metadata.input) && metadata.input.length > 0
      ? { inputModalities: [...metadata.input] }
      : {}),
    ...(metadata.reasoning === true ? { reasoningEfforts: [...ROUTED_COMBO_MEMBER_REASONING_EFFORTS] } : {}),
  };
}

/**
 * Resolve a combo target to a catalog member for derivation.
 * Prefer discovery metadata; when the target is missing from the gather map or
 * lacks a positive contextWindow, synthesize from the (registry-enriched)
 * provider config so combos remain catalogued when targets are configured but
 * discovery metadata is incomplete. Disabled providers stay unresolved.
 * When hints still omit contextWindow, prefer known maxInputTokens, else the
 * enabled Context cap, else COMBO_MEMBER_CONTEXT_FALLBACK so a live row
 * without ctx does not drop the whole combo from the public catalog.
 */
export function resolveComboCatalogMember(
  target: { provider: string; model: string },
  memberByKey: ReadonlyMap<string, CatalogModel>,
  providers: ReadonlyMap<string, OcxProviderConfig>,
  contextCap?: number,
  callerFallback?: ComboCatalogMemberFallback,
  metadataModelIdCaseFold?: boolean,
): CatalogModel | undefined {
  const existing = memberByKey.get(targetKey(target));
  const prov = providers.get(target.provider);
  const fallback = callerFallback ?? vendorMetadataComboFallback(target);
  // Disabled providers never contribute members — even a complete discovery row
  // is unusable for catalog derivation while the provider is off.
  if (prov?.disabled === true) return undefined;

  const withFallbackMetadata = (member: CatalogModel): CatalogModel => {
    const contextWindow = typeof member.contextWindow === "number" && member.contextWindow > 0
      ? member.contextWindow
      : undefined;
    const addMaxInput = fallback !== undefined && contextWindow !== undefined
      && !(typeof member.maxInputTokens === "number" && member.maxInputTokens > 0);
    const addMaxOutput = fallback !== undefined
      && typeof fallback.maxOutputTokens === "number"
      && fallback.maxOutputTokens > 0
      && !(typeof member.maxOutputTokens === "number" && member.maxOutputTokens > 0);
    const effectiveMaxInput = addMaxInput
      ? Math.min(fallback?.maxInputTokens ?? contextWindow!, contextWindow!)
      : member.maxInputTokens;
    const softCandidates = [member.autoCompactTokenLimit, fallback?.autoCompactTokenLimit]
      .filter((value): value is number => typeof value === "number" && value > 0);
    const autoCompactTokenLimit = contextWindow !== undefined && softCandidates.length > 0
      ? clampAutoCompactTokenLimit(contextWindow, effectiveMaxInput, Math.min(...softCandidates))
      : member.autoCompactTokenLimit;
    const adjustAutoCompact = autoCompactTokenLimit !== member.autoCompactTokenLimit;
    const addModalities = (!Array.isArray(member.inputModalities) || member.inputModalities.length === 0)
      && fallback?.inputModalities !== undefined;
    const addReasoning = member.reasoningEfforts === undefined
      && fallback?.reasoningEfforts !== undefined;
    if (!addMaxInput && !addMaxOutput && !adjustAutoCompact && !addModalities && !addReasoning) return member;
    return {
      ...member,
      // Never claim a larger input budget than the window, and prefer the model's own
      // measured ceiling when the fallback carries one.
      ...(addMaxInput ? { maxInputTokens: effectiveMaxInput } : {}),
      ...(addMaxOutput ? { maxOutputTokens: fallback!.maxOutputTokens } : {}),
      ...(adjustAutoCompact && autoCompactTokenLimit !== undefined ? { autoCompactTokenLimit } : {}),
      ...(addModalities ? { inputModalities: [...fallback!.inputModalities!] } : {}),
      ...(addReasoning ? { reasoningEfforts: [...fallback!.reasoningEfforts!] } : {}),
    };
  };

  // Complete live/configured rows still honour providerContextCaps so a high
  // discovery window cannot outrun an operator-configured cap. Native-alias
  // fallback metadata may fill only capability gaps; it never raises an explicit
  // discovered/configured context window.
  if (
    existing
    && typeof existing.contextWindow === "number"
    && existing.contextWindow > 0
  ) {
    // Live discovery can explicitly say text-only even when configured routing
    // supplies a vision sidecar. Apply the same provider hints used for thin
    // rows before deriving a combo from this complete row.
    const hinted = prov && isModelVisionSidecarConsumer(prov, existing.id)
      ? applyProviderConfigHints(target.provider, prov, existing, contextCap, metadataModelIdCaseFold)
      : existing;
    const capped = applyProviderContextCap(hinted.contextWindow, contextCap);
    if (capped === undefined || capped === existing.contextWindow) {
      return withFallbackMetadata(hinted);
    }
    const maxInput = typeof hinted.maxInputTokens === "number" && hinted.maxInputTokens > 0
      ? Math.min(hinted.maxInputTokens, capped)
      : Math.min(fallback?.maxInputTokens ?? capped, capped);
    return withFallbackMetadata({
      ...hinted,
      contextWindow: capped,
      maxInputTokens: maxInput,
      contextCap,
      contextCapped: true as const,
    });
  }

  const base: CatalogModel = existing ?? {
    id: target.model,
    provider: target.provider,
  };
  const hinted = prov
    ? applyProviderConfigHints(target.provider, prov, base, contextCap, metadataModelIdCaseFold)
    : base;
  const hintedContext = typeof hinted.contextWindow === "number" && hinted.contextWindow > 0
    ? hinted.contextWindow
    : undefined;
  const knownMaxInput = typeof hinted.maxInputTokens === "number" && hinted.maxInputTokens > 0
    ? hinted.maxInputTokens
    : (typeof base.maxInputTokens === "number" && base.maxInputTokens > 0
      ? base.maxInputTokens
      : undefined);
  // Kept OUT of knownMaxInput on purpose: that value doubles as a context-window fallback
  // below, and a native alias whose input ceiling (922k) is lower than its window (1.05M)
  // would otherwise shrink the advertised window to the input limit.
  const fallbackMaxInput = existing || prov ? fallback?.maxInputTokens : undefined;
  // Real discovery/config values win. A native alias is the next fallback tier.
  // The generic 128k/text synthesis from #1305 remains the final fallback.
  const fallbackContext = existing || prov ? fallback?.contextWindow : undefined;
  const uncappedContext = hintedContext
    ?? knownMaxInput
    ?? fallbackContext
    ?? (existing || prov ? resolveUnknownRoutedContextWindow(contextCap) : undefined);
  if (uncappedContext === undefined) return undefined;
  // 真发现值才压低。resolveUnknownRoutedContextWindow 已经把 cap 当成窗口填进去了，不能再 min 一次。
  const usedDiscoveredWindow = hintedContext !== undefined || knownMaxInput !== undefined || fallbackContext !== undefined;
  const cappedContext = usedDiscoveredWindow
    ? applyProviderContextCap(uncappedContext, contextCap)
    : uncappedContext;
  const contextWindow = cappedContext ?? uncappedContext;
  const fallbackCapped = usedDiscoveredWindow
    && contextCap !== undefined
    && cappedContext !== undefined
    && cappedContext !== uncappedContext;

  const inputModalities = hinted.inputModalities
    ?? base.inputModalities
    ?? (fallback?.inputModalities ? [...fallback.inputModalities] : undefined)
    ?? ["text"];
  const reasoningEfforts = hinted.reasoningEfforts
    ?? (prov ? configuredReasoningEfforts(prov, target.model) : undefined)
    ?? base.reasoningEfforts
    ?? (fallback?.reasoningEfforts ? [...fallback.reasoningEfforts] : undefined);
  const maxOutputTokens = positiveSafeInteger(hinted.maxOutputTokens, base.maxOutputTokens)
    ?? (existing || prov ? positiveSafeInteger(fallback?.maxOutputTokens) : undefined);
  // The model's own measured input ceiling still applies when discovery gave us nothing:
  // GPT-5.6 advertises a 1.05M window but refuses input past 922k.
  const effectiveMaxInput = knownMaxInput ?? fallbackMaxInput;
  const maxInputTokens = effectiveMaxInput !== undefined
    ? Math.min(effectiveMaxInput, contextWindow)
    : contextWindow;
  const softCandidates = [
    hinted.autoCompactTokenLimit,
    base.autoCompactTokenLimit,
    fallback?.autoCompactTokenLimit,
    configuredAutoCompactTokenLimit(prov, target.model),
  ].filter((value): value is number => typeof value === "number" && value > 0);
  // A generic 128k synthesis is a catalog compatibility fallback, not evidence
  // that a configured soft policy has an authoritative window to clamp against.
  const hasAuthoritativeAutoCompactBasis = hintedContext !== undefined
    || fallbackContext !== undefined
    || contextCap !== undefined;
  const autoCompactTokenLimit = hasAuthoritativeAutoCompactBasis && softCandidates.length > 0
    ? clampAutoCompactTokenLimit(contextWindow, maxInputTokens, Math.min(...softCandidates))
    : undefined;

  return {
    ...hinted,
    inputModalities,
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
    contextWindow,
    maxInputTokens,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(autoCompactTokenLimit !== undefined ? { autoCompactTokenLimit } : {}),
    ...(fallbackCapped ? { contextCap, contextCapped: true as const } : {}),
  };
}
