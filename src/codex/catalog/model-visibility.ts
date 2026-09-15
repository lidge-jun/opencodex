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
import { CALLABLE_CONFIGURED_COMPATIBILITY_MODELS, applyProviderConfigHints } from "./model-hints";

const DATED_VARIANT_YYYYMMDD = /^(\d{4})(\d{2})(\d{2})$/;
const DATED_VARIANT_YYMMDD = /^(2\d)(\d{2})(\d{2})$/;
const DATED_VARIANT_MMDD_OR_YYMM = /^(\d{2})(\d{2})$/;

/** Whether a Gregorian year contains February 29th. */
function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Whether a month/day pair exists in the given year. Without a year, February 29th is
 * accepted because it occurs in at least one calendar year.
 */
function isValidCalendarDate(year: number | undefined, month: number, day: number): boolean {
  if (year !== undefined && (year < 1 || year > 9999)) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [
    31, year === undefined || isLeapYear(year) ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31,
  ];
  return day <= daysInMonth[month - 1]!;
}

/**
 * Release-date suffixes providers actually publish: `YYYYMMDD` (`-20251001`), `YYMMDD`
 * (`-260806`), `MMDD` (`-0813`) and `YYMM` (`-2512`). A `\d{8}`-only rule matched none of
 * the dated ids on a real multi-provider install, so DeepSeek, Kimi, Mistral, Qwen and
 * Solar aliases all fell through to `droppedConfiguredIds` (#3024).
 *
 * Calendar validation rejects impossible month-end and leap-day values as well as ordinary
 * numeric suffixes such as `-2048`, `-4096` and `-8192`. `-1024` is the one irreducible
 * collision — it is a valid `MMDD` (October 24th) — so it reads as dated. That is a known,
 * accepted cost; the test table pins it so it cannot become a surprise later.
 *
 * Hyphenated ISO suffixes (`-2024-08-06`, `-05-06`) are deliberately out of scope: a
 * hyphenated suffix is ambiguous against ordinary name segments and needs its own call.
 */
function isDatedVariantSuffix(suffix: string): boolean {
  const yyyyMmDd = DATED_VARIANT_YYYYMMDD.exec(suffix);
  if (yyyyMmDd) {
    return isValidCalendarDate(
      Number(yyyyMmDd[1]), Number(yyyyMmDd[2]), Number(yyyyMmDd[3]),
    );
  }

  const yyMmDd = DATED_VARIANT_YYMMDD.exec(suffix);
  if (yyMmDd) {
    return isValidCalendarDate(
      2000 + Number(yyMmDd[1]), Number(yyMmDd[2]), Number(yyMmDd[3]),
    );
  }

  const mmDdOrYyMm = DATED_VARIANT_MMDD_OR_YYMM.exec(suffix);
  if (!mmDdOrYyMm) return false;
  const first = Number(mmDdOrYyMm[1]);
  const second = Number(mmDdOrYyMm[2]);
  return isValidCalendarDate(undefined, first, second)
    || (first >= 20 && first <= 29 && second >= 1 && second <= 12);
}

/** Whether `liveId` is a supported dated release of the configured base id. */
export function isDatedVariantId(liveId: string, configuredId: string): boolean {
  if (!liveId.startsWith(`${configuredId}-`)) return false;
  return isDatedVariantSuffix(liveId.slice(configuredId.length + 1));
}

export const lastDropWarnSignature = new Map<string, string>();
let lastWarningReconciledGeneration = 0;

export function reconcileProviderFetchWarnings(generation: number): number {
  if (generation <= lastWarningReconciledGeneration) return 0;
  const removed = lastDropWarnSignature.size;
  lastDropWarnSignature.clear();
  lastWarningReconciledGeneration = generation;
  return removed;
}
export function warnDroppedConfiguredIdsOnce(name: string, droppedConfiguredIds: string[]): void {
  const signature = [...droppedConfiguredIds].sort().join(",");
  if (lastDropWarnSignature.get(name) === signature) return;
  lastDropWarnSignature.set(name, signature);
  console.warn(
    `[opencodex] Provider model discovery for "${name}" omitted configured model ids; dropping them from the authoritative live catalog: ${droppedConfiguredIds.join(", ")}.`,
  );
}
export function shouldExposeProviderModel(providerName: string, modelId: string): boolean {
  if (providerName === "opencode-free") return modelId === "big-pickle" || modelId.endsWith("-free");
  // xAI /models advertises both the dated deployment and this floating alias.
  // Keep only grok-4.20-multi-agent-0309; the alias is the same server-side id.
  if (providerName === "xai" && modelId === "grok-4.20-multi-agent-beta-latest") return false;
  return true;
}

export function shouldRetainConfiguredProviderModel(
  providerName: string,
  modelId: string,
  prov?: OcxProviderConfig,
): boolean {
  if (CALLABLE_CONFIGURED_COMPATIBILITY_MODELS[providerName]?.has(modelId)) return true;
  if (providerName === "opencode-free") return modelId === "big-pickle" || modelId.endsWith("-free");
  if (modelInList(prov?.retainModels, modelId)) return true;
  return false;
}

/**
 * Fold dated-release aliases and retain configured rows that must survive an
 * authoritative live roster (compatibility allow-list, combo targets, Vertex
 * default). Used on every discovery return — live, fresh cache, stale, and
 * failure fallback — so a warm cache captured before a combo existed still
 * surfaces the configured target (OCX-111 / #1308).
 *
 * Cache writes should pass `retainComboTargets: false` so combo retention is
 * re-applied on read against the current capture, not frozen into the TTL entry.
 */
export function mergeConfiguredModelsIntoLiveCatalog(opts: {
  name: string;
  provider: OcxProviderConfig;
  models: readonly CatalogModel[];
  configured: readonly CatalogModel[];
  retainConfiguredModelIds?: ReadonlySet<string>;
  contextCap?: number;
  seedVertexDefault?: boolean;
  retainComboTargets?: boolean;
  metadataModelIdCaseFold?: boolean;
}): { models: CatalogModel[]; droppedConfiguredIds: string[] } {
  const {
    name,
    provider: prov,
    configured,
    retainConfiguredModelIds,
    contextCap,
    seedVertexDefault,
    retainComboTargets = true,
    metadataModelIdCaseFold,
  } = opts;
  const out = [...opts.models];
  const present = new Set(out.map(model => model.id));
  const droppedConfiguredIds: string[] = [];
  for (const candidate of configured) {
    if (present.has(candidate.id)) continue;
    const dated = out.find(live => isDatedVariantId(live.id, candidate.id));
    if (dated) {
      out.push(applyProviderConfigHints(name, prov, { ...dated, id: candidate.id }, contextCap, metadataModelIdCaseFold));
      present.add(candidate.id);
      continue;
    }
    if (
      seedVertexDefault === true
      || shouldRetainConfiguredProviderModel(name, candidate.id, prov)
      || (retainComboTargets && retainConfiguredModelIds?.has(candidate.id) === true)
    ) {
      out.push(candidate);
      present.add(candidate.id);
      continue;
    }
    droppedConfiguredIds.push(candidate.id);
  }
  return { models: out, droppedConfiguredIds };
}

export function filterCatalogVisibleModels(
  models: CatalogModel[],
  config: Pick<OcxConfig, "disabledModels" | "providers">,
): CatalogModel[] {
  const disabled = new Set(config.disabledModels ?? []);
  const allowByProvider = new Map<string, Set<string>>();
  for (const [name, prov] of Object.entries(config.providers)) {
    const sel = prov.selectedModels;
    // Keyed the way `sync.ts` keys the same list, so a slash-bearing native id and
    // the encoded slug the Codex picker displays are one entry rather than two. A
    // bare `Set(sel)` matched only the native form, so an allowlist written from the
    // displayed slug — which `ocx models remove` also accepts — hid every model it
    // was meant to keep.
    //
    // The key is deliberately lossy: `p/a/b` and `p/a-b` collapse to one entry, so a
    // provider publishing both spellings has them selected together. That is a real
    // limitation, pinned by the tests below and tracked as a follow-up; it is NOT
    // fixed here. Resolving selections against the current roster instead was tried
    // and rejected — the roster is an incomplete dictionary (live discovery can omit
    // a published id), so it produces the same over-grant while additionally
    // disagreeing with the `slugEquivalenceKey` contract `sync.ts` uses at merge time.
    // Two catalog stages with different equivalence relations is the exact bug class
    // this change exists to remove.
    if (Array.isArray(sel) && sel.length > 0) {
      allowByProvider.set(name, new Set(sel.map(model => slugEquivalenceKey(routedSlug(name, model)))));
    }
  }
  return models.filter(m => {
    if (initialModelSelectionPending(config.providers[m.provider])) return false;
    const nativeAlias = m.provider === COMBO_NAMESPACE && m.nativeAlias === true;
    // disabledModels may be stored raw (canonical) or encoded (legacy UI writes).
    for (const stored of disabled) {
      // Combo management stores the public alias, while canonical `combo/<id>` references
      // remain valid for backward compatibility through slugEquals below.
      if (m.alias !== undefined && stored === catalogModelSlug(m) && !nativeAlias) return false;
      if (slugEquals(stored, m.provider, m.id)) return false;
    }
    const allow = allowByProvider.get(m.provider);
    return !allow || allow.has(slugEquivalenceKey(routedSlug(m.provider, m.id)));
  });
}
