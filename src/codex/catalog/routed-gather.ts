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
import type { CatalogGatherProviderAuthOutcome, CatalogGatherProviderModelOutcome, GatherFlightCapture, ModelsAuthResolverFactory } from "./gather-capture";
import { applyProviderConfigHints, configuredAutoCompactTokenLimit, configuredMaxInputTokens, configuredReasoningSummarySupport, modelInputModalities, routedMaxOutputTokens } from "./model-hints";
import { resolveComboCatalogMember } from "./combo-member";
import { captureGatherFlight, captureTrustedOpenAiApiPolicy, gatherFlightKey, keyedGatherBytesIdentity, withCanonicalOpenAiForwardAuthDefault } from "./gather-capture";
import { fetchProviderModelsWithAuth, observedModelsAuthResolver, refreshingModelsAuthResolver } from "./provider-models";

export interface GatherRoutedModelsOptions {
  comboOmissions?: ComboCatalogOmission[];
  providerAuthOutcomes?: CatalogGatherProviderAuthOutcome[];
  /** Flight-local authority of each provider's returned model rows. */
  providerModelOutcomes?: CatalogGatherProviderModelOutcome[];
  /** Internal convergence sink for the immutable policy that produced the returned rows. */
  discoveryPolicySnapshots?: CatalogProviderDiscoveryPolicySnapshot[];
}

interface GatherFlightResult {
  models: CatalogModel[];
  comboOmissions: ComboCatalogOmission[];
  providerAuthOutcomes: readonly CatalogGatherProviderAuthOutcome[];
  providerModelOutcomes: readonly CatalogGatherProviderModelOutcome[];
  discoveryPolicySnapshots: readonly CatalogProviderDiscoveryPolicySnapshot[];
}
interface GatherInflightEntry {
  readonly discoveryPolicyIdentity: string;
  /**
   * The credential half of the join decision.
   *
   * `gatherFlightKey`'s fingerprint carries endpoints and model lists but no
   * `authMode`, key or headers, and discovery policy does not carry them either.
   * Two admissions differing ONLY in credential therefore produced the same key
   * and the same policy, so the second joined the first and published rows the
   * old key had fetched — reproduced against the real routes by rotating a key
   * through `/api/providers/keys` mid-flight.
   *
   * Now REDUNDANT with `providerGraphIdentity`, which hashes the whole provider
   * row and therefore covers `apiKey` too: removing this term alone leaves the
   * credential regression green. It is kept deliberately, for two reasons. It
   * covers what the graph cannot — the RESOLVED auth (`observedAuth`) and the
   * final materialized headers, which are derived rather than stored, so an
   * OAuth token that changes while the row is byte-identical still separates
   * admissions. And it states the credential rule where a reader looks for it,
   * instead of leaving it as an emergent property of hashing everything.
   */
  readonly authIdentity: string;
  /**
   * The whole admitted provider graph, not a chosen subset.
   *
   * `providerCatalogFingerprint` is an ALLOW-LIST, so every field it forgot was
   * silently treated as equivalence: credentials leaked a flight until
   * `authIdentity` landed, and `reasoningEfforts` leaked one after that — both
   * reproduced against real routes. Enumerating fields cannot converge, because
   * the next field added to a provider row inherits the same defect. This
   * identity therefore covers the enriched, frozen provider objects the flight
   * actually gathered from, so a join is refused unless the admissions agree on
   * everything rather than on everything somebody remembered to list.
   */
  readonly providerGraphIdentity: string;
  readonly promise: Promise<GatherFlightResult>;
}
const gatherInflight = new Map<string, GatherInflightEntry[]>();
const MAX_CONCURRENT_CATALOG_GATHERS = 8;
const gatherGate = createAdmissionGate("catalog_gathers", MAX_CONCURRENT_CATALOG_GATHERS);

export class CatalogGatherBusyError extends ResourceAdmissionError {
  override readonly code = "catalog_busy";
  readonly retryAfterSeconds = 1;
  constructor() {
    super("catalog_gathers", MAX_CONCURRENT_CATALOG_GATHERS);
    this.name = "CatalogGatherBusyError";
  }
}

export function catalogGatherAdmissionMetrics(): AdmissionMetrics {
  return gatherGate.metrics();
}
/** Drop in-flight gather so tests / full cache clears do not reuse a stale promise. */
export function clearGatherRoutedModelsInflight(): void {
  gatherInflight.clear();
}
export async function gatherRoutedModels(
  config: OcxConfig,
  options?: GatherRoutedModelsOptions,
): Promise<CatalogModel[]> {
  return gatherRoutedModelsWithAuth(
    config,
    `refreshing:${gatherFlightKey(config)}`,
    () => refreshingModelsAuthResolver,
    options,
  );
}

/**
 * Catalog-gather model discovery using only auth-store bytes already captured by the
 * filesystem-evidence owner. This entry point never reaches the refreshing resolver.
 */
export async function gatherRoutedModelsForCatalogGather(
  config: OcxConfig,
  evidence: CatalogGatherProviderAuthEvidence,
  options?: GatherRoutedModelsOptions,
): Promise<CatalogModel[]> {
  const authStoreBuffer = evidence.authStoreBuffer === null
    ? null
    : Uint8Array.from(evidence.authStoreBuffer);
  const authIdentity = authStoreBuffer === null
    ? "absent"
    : keyedGatherBytesIdentity("catalog-observed-auth-v1", authStoreBuffer);
  return gatherRoutedModelsWithAuth(
    config,
    `observed:${authIdentity}:${gatherFlightKey(config)}`,
    outcomes => observedModelsAuthResolver(authStoreBuffer, outcomes),
    options,
  );
}

async function gatherRoutedModelsWithAuth(
  config: OcxConfig,
  key: string,
  createAuthResolver: ModelsAuthResolverFactory,
  options?: GatherRoutedModelsOptions,
): Promise<CatalogModel[]> {
  const capture = captureGatherFlight(config, createAuthResolver);
  const bucket = gatherInflight.get(key) ?? [];
  let entry = bucket.find(candidate => (
    candidate.discoveryPolicyIdentity === capture.discoveryPolicyIdentity
    && candidate.authIdentity === capture.authIdentity
    && candidate.providerGraphIdentity === capture.providerGraphIdentity
  ));
  if (!entry) {
    const lease = gatherGate.tryAcquire();
    if (!lease) throw new CatalogGatherBusyError();
    // Claim the slot synchronously before any await so same-key callers join this flight.
    // Distinct authorities retain separate entries even when their legacy bucket matches.
    let ownedEntry!: GatherInflightEntry;
    const flight = gatherRoutedModelsUncached(config, capture).finally(() => {
      const current = gatherInflight.get(key);
      const index = current?.indexOf(ownedEntry) ?? -1;
      if (current && index >= 0) current.splice(index, 1);
      if (current?.length === 0) gatherInflight.delete(key);
      lease.release();
    });
    ownedEntry = Object.freeze({
      discoveryPolicyIdentity: capture.discoveryPolicyIdentity,
      authIdentity: capture.authIdentity,
      providerGraphIdentity: capture.providerGraphIdentity,
      promise: flight,
    });
    bucket.push(ownedEntry);
    gatherInflight.set(key, bucket);
    entry = ownedEntry;
  }
  const {
    models,
    comboOmissions,
    providerAuthOutcomes,
    providerModelOutcomes,
    discoveryPolicySnapshots,
  } = await entry.promise;
  if (options?.comboOmissions) {
    options.comboOmissions.length = 0;
    options.comboOmissions.push(...comboOmissions);
  }
  if (options?.providerAuthOutcomes) {
    options.providerAuthOutcomes.length = 0;
    options.providerAuthOutcomes.push(...providerAuthOutcomes);
  }
  if (options?.providerModelOutcomes) {
    options.providerModelOutcomes.length = 0;
    options.providerModelOutcomes.push(...providerModelOutcomes);
  }
  if (options?.discoveryPolicySnapshots) {
    options.discoveryPolicySnapshots.length = 0;
    options.discoveryPolicySnapshots.push(...discoveryPolicySnapshots);
  }
  return models;
}

/** Bound a custom row whose model id has pinned native Codex metadata, without changing stored configuration. */
function boundCustomNativeReasoning(
  model: CatalogModel,
  allowed: readonly string[],
  nativeDefault: string | undefined,
): CatalogModel {
  if (allowed.length === 0 || model.reasoningEfforts === undefined) return model;
  const bounded = { ...model };
  if (model.reasoningEfforts.length === 0) {
    bounded.reasoningEfforts = [];
    delete bounded.defaultReasoningEffort;
    return bounded;
  }
  const declared = new Set(model.reasoningEfforts);
  const surviving = [...new Set(allowed)].filter(effort => declared.has(effort));
  const fallback = nativeDefault && allowed.includes(nativeDefault) ? nativeDefault : allowed[0]!;
  // A nonempty but incompatible declaration is not an explicit no-reasoning setting.
  bounded.reasoningEfforts = surviving.length > 0 ? surviving : [fallback];
  bounded.defaultReasoningEffort = model.defaultReasoningEffort
    && bounded.reasoningEfforts.includes(model.defaultReasoningEffort)
    ? model.defaultReasoningEffort
    : bounded.reasoningEfforts.includes(fallback) ? fallback : bounded.reasoningEfforts[0]!;
  return bounded;
}

async function gatherRoutedModelsUncached(
  config: OcxConfig,
  capture: GatherFlightCapture,
): Promise<GatherFlightResult> {
  // Flight-local list: joiners copy from the resolved promise, not a process-global last write.
  const localOmissions: ComboCatalogOmission[] = [];
  const localProviderAuthOutcomes = capture.providerAuthOutcomes;
  const resolveAuth = capture.authResolver;
  const ttlMs = config.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS;
  // Persisted provider entries can predate newer registry fields (noVisionModels,
  // modelInputModalities, ...). The ROUTER merges registry seeds at request time
  // (routedProviderConfig), so the proxy behaves correctly — the catalog listing must see the
  // same merged view or its advertisements drift from actual proxy behavior (e.g. a
  // vision-sidecar model advertised text-only, blocking image attachments app-side).
  // Enrich a CLONE: hydrated defaults must never leak into the persisted config.
  const activeProviders = capture.providers;
  const providerResults = await Promise.all(
    activeProviders.map(provider => fetchProviderModelsWithAuth(
      provider,
      ttlMs,
      providerContextCap(config, provider.name),
      resolveAuth,
    )),
  );
  const lists = providerResults.map(result => result.models);
  const apiAugmented = augmentRoutedModelsWithCapturedOpenAiApiRows(
    lists.flat(),
    config,
    capture.openAiApiPolicy,
  );
  const apiProvider = activeProviders.find(provider => provider.name === OPENAI_API_PROVIDER_ID);
  // Trusted reconstruction replaces whole rows, including the earlier Fast hints.
  // Restore only that capability from the same captured authority used by discovery.
  if (apiProvider) {
    for (const model of apiAugmented) {
      if (model.provider !== OPENAI_API_PROVIDER_ID) continue;
      const policy = fastPolicyForModel(apiProvider.provider, model.id, apiProvider.name);
      const supported = serviceTierSupportFromPolicy(policy);
      if (supported !== undefined) model.supportsServiceTier = supported;
      if (supported === true && policy.fastTierDescription !== undefined) model.fastTierDescription = policy.fastTierDescription;
    }
  }
  const metadataModelIdCaseFoldByProvider = new Map(
    activeProviders.map(provider => [provider.name, provider.metadataModelIdCaseFold]),
  );
  const all = augmentRoutedModelsWithMetadata(
    apiAugmented,
    activeProviders.map(provider => provider.name),
    config.providers,
    config,
    metadataModelIdCaseFoldByProvider,
  )
    // Drop image/video generation models (e.g. Grok image/video) by default. Cursor's static catalog
    // intentionally mirrors Cursor's public model table, including Gemini image preview, so the
    // exposure decision goes through shouldExposeRoutedModel (single choke point).
    .filter(shouldExposeRoutedModel);
  const memberByKey = new Map(all.map(model => [`${model.provider}/${model.id}`, model]));
  // [Decision Log]
  // - 목적과 의도: 콤보 타겟에 native OpenAI(Codex login) 모델이 포함될 때 카탈로그에서
  //   누락되는 버그(issue #268)를 수정. "openai" provider는 forward-auth(Codex login
  //   passthrough)이므로 fetchProviderModels가 항상 []를 반환하고, native slugs는
  //   별도 정적 경로(nativeOpenAiSlugs)로만 노출됨. 따라서 memberByKey에
  //   openai/<slug> 키가 존재하지 않아 콤보가 조용히 drop됨.
  // - 기존 구현 및 제약 조건: memberByKey는 routed provider /models fetch 결과로만 구성.
  // - 검토한 주요 대안: (A) native slugs를 all 배열에 직접 push — /v1/models와 온디스크
  //   카탈로그에서 native 모델이 중복 노출되는 부작용 발생. (B) memberByKey에만 synthetic
  //   CatalogModel을 주입 — 콤보 멤버 해석에만 사용하고 all에는 추가하지 않으므로 기존
  //   노출 경로에 영향 없음.
  // - 선택한 방식: (B) — synthetic entries를 memberByKey에만 주입.
  // - 다른 대안 대신 이 방식을 선택한 이유: 기존 native 모델 노출 경로(/v1/models, 온디스크
  //   카탈로그 sync, management API)를 전혀 변경하지 않고 콤보 resolution만 수선하기 때문.
  // - 장점, 단점 및 영향: 장점 — 최소 수정, 기존 경로 무변경. 단점 — synthetic entries의
  //   capability 데이터가 static/upstream snapshot 기반이므로, 사용자가 커스텀 config
  //   힌트(modelContextWindows 등)로 native 모델의 context window를 오버라이드한 경우
  //   반영되지 않음. 하지만 nativeOpenAiContextWindow가 이미 config 오버라이드를
  //   우선시하므로 실제 충돌 가능성은 낮음.
  if (!hasComboTargets(config)) {
    // Skip the native slug injection entirely when no combos are configured — avoids
    // calling nativeOpenAiSlugs() (which reads the live Codex catalog from disk) for
    // configs that will never need it.
  } else {
    const disabled = disabledNativeSlugs(config);
    const openaiContextCap = nativeContextLimits(config);
    const requiredNativeComboTargets = new Set(listComboIds(config).flatMap(id => {
      const combo = getCombo(config, id);
      return combo?.targets.flatMap(target => (
        target.provider === "openai" ? [target.model] : []
      )) ?? [];
    }));
    for (const slug of nativeOpenAiSlugs()) {
      // A bare native disable key hides the native row, not a combo that targets it.
      // Keep synthetic native metadata available to those combos.
      if (disabled.has(slug) && !requiredNativeComboTargets.has(slug)) continue;
      const contextWindow = nativeOpenAiContextWindow(slug, openaiContextCap);
      if (contextWindow === undefined) continue;
      const synthetic: CatalogModel = {
        provider: "openai",
        id: slug,
        owned_by: "openai",
        contextWindow,
        // Input limit, not the total window. These coincide for native GPT-5.6 today (the
        // advertised 922,000 window is already capped at its measured ceiling), but the two
        // stay separate fields because routed/API rows of the same family run a wider window.
        // Falls back to the window for slugs with no separate ceiling.
        maxInputTokens: Math.min(nativeOpenAiMaxInputTokens(slug, openaiContextCap) ?? contextWindow, contextWindow),
        ...(nativeOpenAiMaxOutputTokens(slug) !== undefined
          ? { maxOutputTokens: nativeOpenAiMaxOutputTokens(slug) }
          : {}),
        autoCompactTokenLimit: nativeOpenAiAutoCompactTokenLimit(slug, openaiContextCap),
        inputModalities: nativeInputModalities(slug),
        reasoningEfforts: nativeReasoningEfforts(slug),
        ...(nativeParallelToolCalls(slug) ? { parallelToolCalls: true } : {}),
      };
      const key = `openai/${slug}`;
      // Only inject when not already present from a routed provider (an API-key
      // "openai" provider could shadow the native one).
      if (!memberByKey.has(key)) memberByKey.set(key, synthetic);
    }
  }
  // [Decision Log]
  // - 목적과 의도: combo derivation must see the same explicit custom-model capabilities that the
  //   final Models inventory publishes. Previously customModels were materialized only after this
  //   map had already derived every combo, so one row could say image while its combo said text.
  // - 기존 구현 및 제약 조건: provider/discovery rows remain the inheritance source, and native
  //   OpenAI synthesis must run first so a sparse custom row cannot hide native hard limits.
  // - 검토한 주요 대안: move the full custom-row materializer ahead of combos, or overlay only the
  //   explicit custom fields onto this private derivation map after provider/native inheritance.
  // - 선택한 방식: use the scoped post-inheritance overlay; the existing final materializer stays
  //   the single owner of public custom-row construction and deduplication.
  // - 다른 대안 대신 이 방식을 선택한 이유: moving the large materializer would reorder public
  //   catalog production and warning behavior, while this map is already private to combo input.
  // - 장점, 단점 및 영향: custom context/modality/reasoning/tool-mode declarations now constrain
  //   their combos without widening unrelated rows; omitted fields retain provider/native limits.
  for (const custom of config.customModels ?? []) {
    const key = `${custom.provider}/${custom.modelId}`;
    const inherited = memberByKey.get(key) ?? {
      provider: custom.provider,
      id: custom.modelId,
      owned_by: custom.provider,
    };
    memberByKey.set(key, {
      ...inherited,
      catalogKind: CODEX_CUSTOM_MODEL_CATALOG_KIND,
      ...(typeof custom.contextWindow === "number" && custom.contextWindow > 0
        ? { contextWindow: custom.contextWindow }
        : {}),
      ...(Array.isArray(custom.inputModalities)
        ? { inputModalities: [...custom.inputModalities] }
        : {}),
      ...(Array.isArray(custom.reasoningEfforts)
        ? { reasoningEfforts: [...custom.reasoningEfforts] }
        : {}),
      ...(custom.codexToolMode !== undefined ? { codexToolMode: custom.codexToolMode } : {}),
    });
  }
  // Enriched (registry-hydrated) provider clones — shared by combo member synthesis and
  // custom-model vision-sidecar inheritance so both see the same merged registry view.
  const enrichedByName = new Map(activeProviders.map(provider => [provider.name, provider.provider]));
  for (const id of listComboIds(config)) {
    const combo = getCombo(config, id);
    if (!combo) continue;
    const comboNativeLimits = nativeContextLimits(config);
    const nativeContextWindow = combo.nativeAlias && combo.alias
      ? nativeOpenAiContextWindow(combo.alias, comboNativeLimits)
      : undefined;
    const nativeAliasMaxInput = combo.nativeAlias && combo.alias
      ? (combo.alias.startsWith("gpt-5.6-") || combo.alias.includes("daybreak")
        ? NATIVE_GPT56_MAX_INPUT_TOKENS
        : nativeOpenAiMaxInputTokens(combo.alias, comboNativeLimits) ?? nativeOpenAiContextWindow(combo.alias, comboNativeLimits))
      : undefined;
    const nativeAliasAutoCompact = combo.nativeAlias && combo.alias
      ? nativeOpenAiAutoCompactTokenLimit(combo.alias, comboNativeLimits)
      : undefined;
    const nativeAliasFallback = combo.nativeAlias && combo.alias && nativeContextWindow !== undefined
      ? {
        contextWindow: nativeContextWindow,
        ...(nativeAliasMaxInput !== undefined ? { maxInputTokens: nativeAliasMaxInput } : {}),
        ...(nativeOpenAiMaxOutputTokens(combo.alias) !== undefined
          ? { maxOutputTokens: nativeOpenAiMaxOutputTokens(combo.alias) }
          : {}),
        ...(nativeAliasAutoCompact !== undefined ? { autoCompactTokenLimit: nativeAliasAutoCompact } : {}),
        inputModalities: nativeInputModalities(combo.alias),
        reasoningEfforts: nativeReasoningEfforts(combo.alias),
      }
      : undefined;
    const members = combo.targets
      .map(target => resolveComboCatalogMember(
        target,
        memberByKey,
        enrichedByName,
        providerContextCap(config, target.provider),
        nativeAliasFallback,
        metadataModelIdCaseFoldByProvider.get(target.provider),
      ))
      .filter((member): member is CatalogModel => member !== undefined);
    const derived = deriveComboCatalogModel(id, combo, members);
    if (derived) {
      const nativeDefault = combo.nativeAlias && combo.alias
        ? nativeDefaultReasoningEffort(combo.alias)
        : undefined;
      if (combo.defaultEffort === null
        && nativeDefault
        && derived.reasoningEfforts?.includes(nativeDefault)) {
        derived.defaultReasoningEffort = nativeDefault;
      }
      all.push(derived);
    }
    else warnUncataloguedComboOnce(id, combo, members, localOmissions);
  }
  replaceLastComboCatalogOmissions(localOmissions);
  all.sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)));
  // Provider-derived rows keyed by their Codex-facing slug: a custom override replaces the row
  // with the same slug below, so that row's provider capability metadata is the inheritance source.
  const replacedByRoutedSlug = new Map(all.map(model => [routedSlug(model.provider, model.id), model]));
  const customModels = (config.customModels ?? []).map(cm => {
    const rawProvider = config.providers[cm.provider];
    const effectiveProvider = enrichedByName.get(cm.provider) ?? rawProvider;
    // Registry routing backfills an omitted authMode on the built-in OpenAI provider to
    // forward. Keep the catalog projection on the same contract while still failing closed
    // for every explicit non-forward mode and every non-canonical endpoint.
    const providerForCanonicalCheck = rawProvider
      ? withCanonicalOpenAiForwardAuthDefault(cm.provider, rawProvider)
      : undefined;
    const codexForwardNativeCapabilityAlias = cm.provider === OPENAI_CODEX_PROVIDER_ID
      && providerForCanonicalCheck !== undefined
      && isCanonicalOpenAiForwardProvider(providerForCanonicalCheck)
      && hasNativeOpenAiCapabilityMetadata(cm.modelId);
    const customNativeLimits = {
      ...nativeContextLimits(config),
      ...(typeof cm.contextWindow === "number" && cm.contextWindow > 0
        ? { modelWindows: { ...(nativeContextLimits(config).modelWindows ?? {}), [cm.modelId]: cm.contextWindow } }
        : {}),
    };
    const nativeAliasContextWindow = codexForwardNativeCapabilityAlias
      ? nativeOpenAiContextWindow(cm.modelId, customNativeLimits)
      : undefined;
    const customContextWindow = cm.contextWindow
      ? nativeAliasContextWindow !== undefined
        ? nativeAliasContextWindow
        : cm.contextWindow
      : nativeAliasContextWindow;
    const nativeAliasMaxInputTokens = codexForwardNativeCapabilityAlias
      ? nativeOpenAiMaxInputTokens(cm.modelId, customNativeLimits)
      : undefined;
    const nativeAliasMaxOutputTokens = codexForwardNativeCapabilityAlias
      ? nativeOpenAiMaxOutputTokens(cm.modelId)
      : undefined;
    const configuredMaxInput = rawProvider
      ? configuredMaxInputTokens(rawProvider, cm.modelId)
      : undefined;
    const hardMaxCandidates = [nativeAliasMaxInputTokens, configuredMaxInput]
      .filter((value): value is number => typeof value === "number" && value > 0);
    const customMaxInputTokens = hardMaxCandidates.length > 0
      ? Math.min(
        ...hardMaxCandidates,
        ...(customContextWindow !== undefined ? [customContextWindow] : []),
      )
      : undefined;
    const customMaxOutputTokens = rawProvider
      ? routedMaxOutputTokens(cm.provider, rawProvider, {
        id: cm.modelId,
        provider: cm.provider,
        ...(nativeAliasMaxOutputTokens !== undefined ? { maxOutputTokens: nativeAliasMaxOutputTokens } : {}),
      }, cm.modelId, metadataModelIdCaseFoldByProvider.get(cm.provider))
      : nativeAliasMaxOutputTokens;
    const configuredAutoCompact = configuredAutoCompactTokenLimit(rawProvider, cm.modelId);
    const customAutoCompactTokenLimit = codexForwardNativeCapabilityAlias
      ? nativeOpenAiAutoCompactTokenLimit(cm.modelId, customNativeLimits)
      : customContextWindow !== undefined && configuredAutoCompact !== undefined
        ? clampAutoCompactTokenLimit(customContextWindow, customMaxInputTokens, configuredAutoCompact)
        : undefined;
    const nativeAliasDefaultEffort = codexForwardNativeCapabilityAlias
      ? nativeDefaultReasoningEffort(cm.modelId)
      : undefined;
    const supportsReasoningSummaries = configuredReasoningSummarySupport(rawProvider, cm.modelId);
    const fastPolicy = effectiveProvider
      ? fastPolicyForModel(effectiveProvider, cm.modelId, cm.provider)
      : undefined;
    const supportsServiceTier = fastPolicy
      ? serviceTierSupportFromPolicy(fastPolicy)
      : undefined;
    const base: CatalogModel = {
      id: cm.modelId,
      provider: cm.provider,
      catalogKind: CODEX_CUSTOM_MODEL_CATALOG_KIND,
      // Display-only label: never feeds routing (customModels are keyed by routedSlug below).
      ...(cm.displayName
        ? { displayName: cm.displayName }
        : codexForwardNativeCapabilityAlias
          ? { displayName: nativeOpenAiCapabilityDisplayName(cm.modelId) ?? cm.modelId } : {}),
      ...(customContextWindow !== undefined ? { contextWindow: customContextWindow } : {}),
      ...(customMaxInputTokens !== undefined ? { maxInputTokens: customMaxInputTokens } : {}),
      ...(customMaxOutputTokens !== undefined ? { maxOutputTokens: customMaxOutputTokens } : {}),
      ...(customAutoCompactTokenLimit !== undefined ? { autoCompactTokenLimit: customAutoCompactTokenLimit } : {}),
      ...(cm.inputModalities
        ? { inputModalities: cm.inputModalities }
        : codexForwardNativeCapabilityAlias ? { inputModalities: nativeInputModalities(cm.modelId) } : {}),
      ...(typeof supportsReasoningSummaries === "boolean" ? { supportsReasoningSummaries } : {}),
      // Native-alias defaults apply only where the custom row declares nothing: the explicit
      // spreads below must win (later in object order), so a stored `[]` stays empty and a
      // declared ladder is narrowed to proven native capabilities after the merge below.
      ...(codexForwardNativeCapabilityAlias
        ? {
          codexForwardNativeCapabilityAlias: true,
          parallelToolCalls: nativeParallelToolCalls(cm.modelId),
          ...(Array.isArray(cm.reasoningEfforts)
            ? {}
            : {
              reasoningEfforts: nativeReasoningEfforts(cm.modelId),
              ...(nativeAliasDefaultEffort ? { defaultReasoningEffort: nativeAliasDefaultEffort } : {}),
            }),
        }
        : {}),
      // Explicit custom-row ladder wins over the inherited provider row below: the merge only
      // gap-fills, so a stored `[]` (explicit "no reasoning") or a declared ladder is kept
      // instead of being replaced by that row's metadata. Capability-backed native model ids
      // are bounded against their own pinned ladder after the merge, including gateways.
      ...(Array.isArray(cm.reasoningEfforts) ? { reasoningEfforts: [...cm.reasoningEfforts] } : {}),
      ...(cm.defaultReasoningEffort ? { defaultReasoningEffort: cm.defaultReasoningEffort } : {}),
      ...(typeof supportsServiceTier === "boolean" ? { supportsServiceTier } : {}),
      ...(supportsServiceTier === true && fastPolicy?.fastTierDescription !== undefined
        ? { fastTierDescription: fastPolicy.fastTierDescription }
        : {}),
      ...(cm.codexToolMode !== undefined
        ? { codexToolMode: cm.codexToolMode }
        : effectiveProvider?.codexToolMode !== undefined
          ? { codexToolMode: effectiveProvider.codexToolMode }
          : {}),
    };
    // #962: the dedupe below drops the provider-derived row this custom row replaces. Inherit that
    // row's provider capability metadata (reasoning ladder, default effort, parallel tool calls,
    // context, ...) so the generated catalog keeps advertising what the router actually provides.
    // Explicit custom fields win by construction; this only fills gaps. Without it a
    // noReasoningModels model loses its empty ladder and the catalog synthesizes the generic one,
    // which Codex then rejects for spawn_agent with effort "none".
    const replaced = replacedByRoutedSlug.get(routedSlug(cm.provider, cm.modelId));
    // The final ladder is what the catalog will advertise; the inherited default only rides
    // along when it is actually a member — otherwise a provider default like "xhigh" would
    // re-apply onto a narrower custom ladder and override the fallback in applyReasoningLevels.
    const effectiveLadder = base.reasoningEfforts ?? replaced?.reasoningEfforts;
    const mergedMaxInputCandidates = [base.maxInputTokens, replaced?.maxInputTokens]
      .filter((value): value is number => typeof value === "number" && value > 0);
    const mergedMaxInput = mergedMaxInputCandidates.length > 0
      ? Math.min(...mergedMaxInputCandidates)
      : undefined;
    const mergedMaxOutputCandidates = [base.maxOutputTokens, replaced?.maxOutputTokens]
      .filter((value): value is number => typeof value === "number" && value > 0);
    const mergedMaxOutput = mergedMaxOutputCandidates.length > 0
      ? Math.min(...mergedMaxOutputCandidates)
      : undefined;
    const merged: CatalogModel = replaced ? {
      ...base,
      ...(base.contextWindow === undefined && replaced.contextWindow !== undefined ? { contextWindow: replaced.contextWindow } : {}),
      ...(mergedMaxInput !== undefined ? { maxInputTokens: mergedMaxInput } : {}),
      ...(mergedMaxOutput !== undefined ? { maxOutputTokens: mergedMaxOutput } : {}),
      ...(base.autoCompactTokenLimit === undefined && replaced.autoCompactTokenLimit !== undefined
        ? { autoCompactTokenLimit: replaced.autoCompactTokenLimit }
        : {}),
      ...(base.inputModalities === undefined && replaced.inputModalities !== undefined ? { inputModalities: replaced.inputModalities } : {}),
      ...(base.reasoningEfforts === undefined && replaced.reasoningEfforts !== undefined ? { reasoningEfforts: replaced.reasoningEfforts } : {}),
      ...(base.defaultReasoningEffort === undefined && replaced.defaultReasoningEffort !== undefined
        && Array.isArray(effectiveLadder) && effectiveLadder.includes(replaced.defaultReasoningEffort)
        ? { defaultReasoningEffort: replaced.defaultReasoningEffort } : {}),
      ...(base.parallelToolCalls === undefined && replaced.parallelToolCalls !== undefined ? { parallelToolCalls: replaced.parallelToolCalls } : {}),
      ...(base.supportsVerbosity === undefined && replaced.supportsVerbosity !== undefined ? { supportsVerbosity: replaced.supportsVerbosity } : {}),
      ...(base.supportsReasoningSummaries === undefined && replaced.supportsReasoningSummaries !== undefined ? { supportsReasoningSummaries: replaced.supportsReasoningSummaries } : {}),
      ...(base.codexToolMode === undefined && replaced.codexToolMode !== undefined ? { codexToolMode: replaced.codexToolMode } : {}),
      ...(base.capabilities === undefined && replaced.capabilities !== undefined ? { capabilities: replaced.capabilities } : {}),
    } : base;
    // Catalog-advertised efforts are bounded whenever the model id is a pinned native
    // slug. Desktop validates that id, so a gateway such as YYLJ/gpt-6-astra still cannot
    // advertise none/minimal. Full native identity stays behind the alias predicate.
    const nativeEffortSource = hasNativeOpenAiCapabilityMetadata(cm.modelId);
    const reasoningBounded = nativeEffortSource
      ? boundCustomNativeReasoning(
        merged,
        nativeReasoningEfforts(cm.modelId),
        nativeAliasDefaultEffort ?? nativeDefaultReasoningEffort(cm.modelId),
      )
      : merged;
    // Vision-sidecar coverage only: when the enriched provider's shared predicate matches
    // noVisionModels or text-without-image modelInputModalities, advertise image input so the
    // Codex app lets images reach the sidecar (#349/#344). Deliberately NOT the full
    // applyProviderConfigHints pass — custom rows are a
    // user override, so their explicit contextWindow / inputModalities / reasoning fields must be
    // preserved verbatim (the hint pass would cap context and overwrite modalities from registry).
    const mergedContext = typeof reasoningBounded.contextWindow === "number" && reasoningBounded.contextWindow > 0
      ? reasoningBounded.contextWindow
      : undefined;
    const boundedMergedMaxInput = typeof reasoningBounded.maxInputTokens === "number" && reasoningBounded.maxInputTokens > 0
      ? (mergedContext !== undefined ? Math.min(reasoningBounded.maxInputTokens, mergedContext) : reasoningBounded.maxInputTokens)
      : undefined;
    const mergedWithHardBounds = boundedMergedMaxInput !== undefined
      && boundedMergedMaxInput !== reasoningBounded.maxInputTokens
      ? { ...reasoningBounded, maxInputTokens: boundedMergedMaxInput }
      : reasoningBounded;
    const mergedSoftCandidates = [mergedWithHardBounds.autoCompactTokenLimit, configuredAutoCompact]
      .filter((value): value is number => typeof value === "number" && value > 0);
    const mergedWithAutoCompact: CatalogModel = mergedContext !== undefined && mergedSoftCandidates.length > 0
      ? {
        ...mergedWithHardBounds,
        autoCompactTokenLimit: clampAutoCompactTokenLimit(
          mergedContext,
          boundedMergedMaxInput,
          Math.min(...mergedSoftCandidates),
        ),
      }
      : mergedWithHardBounds;
    const enrichedProvider = enrichedByName.get(cm.provider) ?? rawProvider;
    // Reuse the request-time consumer predicate so custom rows cannot drift from catalog hints.
    if (enrichedProvider && isModelVisionSidecarConsumer(enrichedProvider, mergedWithAutoCompact.id)) {
      const current = mergedWithAutoCompact.inputModalities ?? ["text"];
      if (!current.includes("image")) {
        return { ...mergedWithAutoCompact, inputModalities: [...current, "image"] };
      }
    }
    return mergedWithAutoCompact;
  });
  // Custom rows override discovered rows that encode to the same Codex-facing slug.
  const customKeys = new Set(customModels.map(c => routedSlug(c.provider, c.id)));
  const deduped = all.filter(m => !customKeys.has(routedSlug(m.provider, m.id)));
  const models = [...deduped, ...customModels];
  // ponytail: catalog-scale scan; index ids by provider if catalog growth makes this measurable.
  const aliasDisplayNames = new Map(activeProviders.flatMap(({ name, provider }) => {
    const providerModels = models.filter(model => model.provider === name);
    const aliases = [...effectiveModelAliases(config, provider, providerModels.map(model => model.id))];
    return aliases.flatMap(([id, { alias }]) => {
      const exact = providerModels.filter(model => model.id === id);
      const matches = exact.length > 0
        ? exact
        : providerModels.filter(model => model.id.toLowerCase() === id.toLowerCase());
      return matches.length === 1
        ? [[`${name}/${matches[0]!.id}`, `${provider.alias || name}/${alias}`] as const]
        : [];
    });
  }));
  const providerModelOutcomes = providerResults.map(result => (
    result.outcome.provider === OPENAI_API_PROVIDER_ID
      && capture.openAiApiPolicy.state === "captured"
      && capture.openAiApiPolicy.models !== undefined
      ? { provider: result.outcome.provider, state: "authoritative" as const }
      : result.outcome
  ));
  return {
    models: models.map(model => {
      const displayName = aliasDisplayNames.get(`${model.provider}/${model.id}`);
      // #1711: one stamping point for every row this gather produces — routed, combo, and custom
      // alike — because it is the only place that has both the finished list and the config the
      // quota rules need. A combo votes over its own targets; anything else votes over the single
      // provider that would serve it.
      const targets = model.provider === COMBO_NAMESPACE
        ? config.combos?.[model.id]?.targets ?? []
        : [{ provider: model.provider }];
      const inactive = quotaInactiveReason(config, targets);
      const named = displayName && !model.displayName ? { ...model, displayName } : model;
      return inactive ? { ...named, quotaInactiveReason: inactive } : named;
    }),
    comboOmissions: localOmissions,
    providerAuthOutcomes: localProviderAuthOutcomes,
    providerModelOutcomes,
    discoveryPolicySnapshots: capture.discoveryPolicySnapshots,
  };
}

export function augmentRoutedModelsWithRegistryOpenAiApiRows(
  models: CatalogModel[],
  config: OcxConfig,
): CatalogModel[] {
  const configured = config.providers[OPENAI_API_PROVIDER_ID];
  if (!configured || configured.disabled === true || !providerMatchesRegistryTransport(OPENAI_API_PROVIDER_ID, configured)) return models;
  return augmentRoutedModelsWithCapturedOpenAiApiRows(
    models,
    config,
    captureTrustedOpenAiApiPolicy(OPENAI_API_PROVIDER_ID, true),
  );
}

function augmentRoutedModelsWithCapturedOpenAiApiRows(
  models: CatalogModel[],
  config: OcxConfig,
  policy: CatalogTrustedOpenAiApiPolicySnapshot,
): CatalogModel[] {
  if (policy.state !== "captured" || !policy.models) return models;
  const configured = config.providers[OPENAI_API_PROVIDER_ID];
  if (!configured || configured.disabled === true) return models;

  const existingById = new Map(
    models.filter(model => model.provider === OPENAI_API_PROVIDER_ID).map(model => [model.id, model]),
  );
  const trustedRows = policy.models.map((id): CatalogModel => {
    const officialContext = policy.modelContextWindows?.[id];
    const officialMaxInput = policy.modelMaxInputTokens?.[id];
    const userContext = configured.modelContextWindows?.[id] ?? configured.contextWindow;
    const userMaxInput = configured.modelMaxInputTokens?.[id];
    const providerCap = providerContextCap(config, OPENAI_API_PROVIDER_ID);
    const contextWindow = typeof officialContext === "number"
      ? Math.min(officialContext, userContext ?? officialContext, providerCap ?? officialContext)
      : undefined;
    const maxInputTokens = typeof officialMaxInput === "number"
      ? Math.min(
        officialMaxInput,
        userMaxInput ?? officialMaxInput,
        contextWindow ?? officialMaxInput,
      )
      : undefined;
    const configuredAutoCompact = configuredAutoCompactTokenLimit(configured, id);
    const autoCompactTokenLimit = contextWindow !== undefined && configuredAutoCompact !== undefined
      ? clampAutoCompactTokenLimit(contextWindow, maxInputTokens, configuredAutoCompact)
      : undefined;
    const maxOutputTokens = routedMaxOutputTokens(
      OPENAI_API_PROVIDER_ID,
      configured,
      policy.modelMaxOutputTokens?.[id] !== undefined
        ? { provider: OPENAI_API_PROVIDER_ID, id, maxOutputTokens: policy.modelMaxOutputTokens[id] }
        : existingById.get(id) ?? { provider: OPENAI_API_PROVIDER_ID, id },
      policy.virtualModels?.[id]?.wireModelId ?? id,
    );
    return {
      provider: OPENAI_API_PROVIDER_ID,
      id,
      owned_by: OPENAI_API_PROVIDER_ID,
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxInputTokens ? { maxInputTokens } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(autoCompactTokenLimit !== undefined ? { autoCompactTokenLimit } : {}),
      ...(policy.modelInputModalities?.[id] ? { inputModalities: [...policy.modelInputModalities[id]!] } : {}),
      ...(policy.modelReasoningEfforts?.[id] ? { reasoningEfforts: [...policy.modelReasoningEfforts[id]!] } : {}),
    };
  });

  for (const trusted of trustedRows) {
    const live = existingById.get(trusted.id);
    if (!live) continue;
    const liveSignature = normalizedOpenAiApiSignature(live);
    const trustedSignature = normalizedOpenAiApiSignature(trusted);
    if (liveSignature === trustedSignature) continue;
    const warningKey = `${trusted.provider}/${trusted.id}\n${liveSignature}\n${trustedSignature}`;
    if (openAiApiCollisionWarnings.has(warningKey)) continue;
    openAiApiCollisionWarnings.add(warningKey);
    console.warn(`[opencodex] replacing conflicting live OpenAI API metadata for ${trusted.provider}/${trusted.id} with trusted registry metadata`);
  }

  return [
    ...models.filter(model => model.provider !== OPENAI_API_PROVIDER_ID),
    ...trustedRows,
  ];
}

export function augmentRoutedModelsWithMetadata(
  models: CatalogModel[],
  providerNames: string[],
  providers?: Record<string, OcxProviderConfig>,
  caps?: Pick<OcxConfig, "providerContextCaps">,
  metadataModelIdCaseFoldByProvider?: ReadonlyMap<string, boolean>,
): CatalogModel[] {
  const out = [...models];
  const seen = new Set(out.map(m => `${m.provider}/${m.id}`));
  for (const provider of providerNames) {
    if (!JAWCODE_CATALOG_AUGMENT_PROVIDERS.has(provider)) continue;
    if (providers?.[provider]?.liveModels === false) continue;
    const jawcodeProvider = resolveMetadataProvider(provider);
    if (!jawcodeProvider) continue;
    for (const meta of listModelMetadata(jawcodeProvider)) {
      const key = `${provider}/${meta.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const contextCap = caps ? providerContextCap(caps, provider) : undefined;
      const model: CatalogModel = {
        provider,
        id: meta.id,
        owned_by: provider,
        ...(typeof meta.contextWindow === "number" && meta.contextWindow > 0 ? { contextWindow: meta.contextWindow } : {}),
        ...(typeof meta.maxTokens === "number" && meta.maxTokens > 0 ? { maxOutputTokens: meta.maxTokens } : {}),
        ...(Array.isArray(meta.input) && meta.input.length > 0 ? { inputModalities: [...meta.input] } : {}),
      };
      out.push({
        ...model,
        ...(providers?.[provider]
          ? applyProviderConfigHints(
            provider,
            providers[provider],
            model,
            contextCap,
            metadataModelIdCaseFoldByProvider?.get(provider),
          )
          : {}),
      });
    }
  }
  return out;
}
