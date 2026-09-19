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
  observeModelCacheRevision,
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
import type { CapturedProviderGather, CatalogGatherProviderAuthOutcome, CatalogGatherProviderModelOutcome, ModelsAuthResolution, ModelsAuthResolver } from "./gather-capture";
import { QUIET_AUTHORITATIVE_CATALOG_PROVIDERS, applyConfigHintsToCachedModels, applyProviderConfigHints, boundedOwnedBy, catalogHintsFromModelsApiItem, catalogHintsFromProviderConfig } from "./model-hints";
import { mergeConfiguredModelsIntoLiveCatalog, shouldExposeProviderModel, warnDroppedConfiguredIdsOnce } from "./model-visibility";
import { captureProviderGather, materializeCapturedHeaders } from "./gather-capture";

export interface ProviderModelsResult {
  readonly models: CatalogModel[];
  readonly outcome: CatalogGatherProviderModelOutcome;
  /**
   * The provider's cache content revision as it stood when these rows were chosen.
   *
   * Sampled here rather than by the caller because only this point is synchronous with the
   * choice. A caller reading it after its own await can observe a revision another flight
   * published in between, and would then record these rows under that flight's identity.
   */
  readonly contentRevision: string;
}
export const refreshingModelsAuthResolver: ModelsAuthResolver = { kind: "refreshing" };

export function observedModelsAuthResolver(
  authStoreBuffer: Uint8Array | null,
  outcomes: CatalogGatherProviderAuthOutcome[],
): ModelsAuthResolver {
  return {
    kind: "observed",
    resolve(name, provider) {
      if (provider.authMode === "forward") return { apiKey: undefined, observed: true };
      if (provider.authMode !== "oauth") {
        return { apiKey: resolveProviderApiKey(provider.apiKey), observed: true };
      }

      const observation = observeActiveOAuthAccessToken(name, authStoreBuffer);
      outcomes.push({ provider: name, state: observation.kind });
      if (observation.kind !== "available") return { apiKey: undefined, observed: true };
      return {
        apiKey: observation.snapshot.accessToken,
        observed: true,
        ...(observation.snapshot.apiBaseUrl ? { oauthApiBaseUrl: observation.snapshot.apiBaseUrl } : {}),
        ...(observation.snapshot.projectId ? { oauthProjectId: observation.snapshot.projectId } : {}),
      };
    },
  };
}
export async function fetchProviderModelsWithAuth(
  captured: CapturedProviderGather,
  ttlMs: number,
  contextCap: number | undefined,
  resolveAuth: ModelsAuthResolver,
): Promise<ProviderModelsResult> {
  const { name, provider: prov, discovery, request, metadataModelIdCaseFold } = captured;
  const observed = (
    models: CatalogModel[],
    state: CatalogGatherProviderModelOutcome["state"],
  ): ProviderModelsResult => ({
    models,
    outcome: { provider: name, state },
    contentRevision: observeModelCacheRevision(name),
  });
  // Capture before any credential refresh or outbound await. OAuth account changes clear this
  // generation, so a request started with the former account cannot later publish its result.
  const cacheGeneration = captureModelCacheGeneration(name);
  const isCurrentCacheGeneration = () => isModelCacheGenerationCurrent(name, cacheGeneration);
  if (prov.authMode === "forward") return observed([], "authoritative"); // ChatGPT backend has no /models
  const seedVertexDefault = prov.adapter === "google"
    && prov.googleMode === "vertex"
    && (prov.models?.length ?? 0) === 0
    && Boolean(prov.defaultModel);
  const seedStaticDefault = prov.liveModels === false
    && (prov.models?.length ?? 0) === 0
    && Boolean(prov.defaultModel);
  // Ordered dedupe union: implicit default seed, then `models`, then `retainModels`. `configured` is the
  // single seed for the static path, the degraded fallback, drop diagnostics, and provider hints,
  // so a retain-only id must enter here or it never exists to be retained (#1690).
  const configuredIds = [...new Set([
    ...((seedVertexDefault || seedStaticDefault) && prov.defaultModel ? [prov.defaultModel] : []),
    ...(prov.models ?? []),
    ...(prov.retainModels ?? []),
  ])];
  const configured: CatalogModel[] = configuredIds.map(id => ({
    id,
    provider: name,
    ...catalogHintsFromProviderConfig(name, prov, id, contextCap, metadataModelIdCaseFold, captured.effectiveAlias),
  }));
  const withConfiguredRetention = (
    models: CatalogModel[],
    options?: { retainComboTargets?: boolean; warnDrops?: boolean },
  ): CatalogModel[] => {
    const { models: merged, droppedConfiguredIds } = mergeConfiguredModelsIntoLiveCatalog({
      name,
      provider: prov,
      models,
      configured,
      retainConfiguredModelIds: captured.retainConfiguredModelIds,
      contextCap,
      seedVertexDefault,
      retainComboTargets: options?.retainComboTargets,
      metadataModelIdCaseFold,
    });
    if (
      options?.warnDrops === true
      && droppedConfiguredIds.length > 0
      && name !== OPENAI_API_PROVIDER_ID
      && !QUIET_AUTHORITATIVE_CATALOG_PROVIDERS.has(name)
    ) {
      warnDroppedConfiguredIdsOnce(name, droppedConfiguredIds);
    }
    return merged;
  };
  // Static catalogs never need an OAuth refresh or an upstream model request. Clear any
  // discovery failure left by an older live configuration even when the account is logged out.
  if (prov.liveModels === false) {
    clearProviderDiscoveryStatus(name);
    return observed(configured, "authoritative");
  }
  const auth: ModelsAuthResolution = captured.observedAuth ?? (resolveAuth.kind === "refreshing"
    ? prov.authMode === "oauth" && effectiveGoogleMode(name, prov) === "cloud-code-assist"
      ? await getValidAccessTokenSnapshot(name)
        .then(snapshot => ({
          apiKey: snapshot.accessToken,
          observed: false,
          ...(snapshot.projectId ? { oauthProjectId: snapshot.projectId } : {}),
        }))
        .catch(() => ({ apiKey: undefined, observed: false }))
      : { apiKey: await resolveModelsAuthToken(name, prov), observed: false }
    : resolveAuth.resolve(name, prov));
  const apiKey = auth.apiKey;
  // A configured default is a real callable selector and must remain discoverable when a
  // compatible provider's live /models request fails (issue #308). Static providers already seed
  // their default selector above when no explicit model list exists.
  const failedDiscoveryConfigured = configured.length > 0 || !prov.defaultModel || prov.adapter !== "anthropic"
    ? configured
    : [{
      id: prov.defaultModel,
      provider: name,
      ...catalogHintsFromProviderConfig(name, prov, prov.defaultModel, contextCap, metadataModelIdCaseFold, captured.effectiveAlias),
    }];
  const vertexDefaultSeed = seedVertexDefault ? configured[0] : undefined;
  const withVertexDefaultSeed = (models: CatalogModel[]): CatalogModel[] => (
    vertexDefaultSeed && !models.some(model => model.id === vertexDefaultSeed.id)
      ? [...models, vertexDefaultSeed]
      : models
  );
  if (prov.adapter === "qoder") {
    if (!apiKey) return observed(configured, "degraded");
    const profile = resolveQoderProfile(prov.baseUrl);
    if (!profile) return observed(configured, "degraded");
    // Qoder's model list is entitlement-specific. Bind cache reads/writes to an irreversible PAT
    // fingerprint so an account switch cannot observe another account's roster, even if a caller
    // bypasses the normal config mutation path that clears provider caches.
    const authorityIdentity = createHash("sha256").update(apiKey).digest("hex");
    const fresh = getFreshCached(name, ttlMs, Date.now(), authorityIdentity);
    if (fresh) {
      return observed(withConfiguredRetention(
        applyConfigHintsToCachedModels(name, prov, fresh, contextCap, metadataModelIdCaseFold, captured.effectiveAlias),
      ), "authoritative");
    }
    const scopedStale = getStaleCached(name, authorityIdentity);
    if (isModelsFetchCoolingDown(name) && scopedStale) {
      return observed(withConfiguredRetention(
        applyConfigHintsToCachedModels(name, prov, scopedStale, contextCap, metadataModelIdCaseFold, captured.effectiveAlias),
      ), "degraded");
    }
    const live = await fetchQoderModels(profile, apiKey);
    if (live.ok) {
      const discovered = live.models.map(id => ({
        id,
        provider: name,
        ...catalogHintsFromProviderConfig(name, prov, id, contextCap, metadataModelIdCaseFold, captured.effectiveAlias),
      }));
      const forCache = withConfiguredRetention(discovered, { retainComboTargets: false });
      if (!setCached(name, forCache, Date.now(), cacheGeneration, authorityIdentity)) {
        return observed(withConfiguredRetention(configured), "degraded");
      }
      markProviderDiscoveryOk(name, live.models.length);
      return observed(withConfiguredRetention(forCache, { warnDrops: true }), "authoritative");
    }
    if (isCurrentCacheGeneration()) {
      markModelsFetchFailure(name);
      markProviderDiscoveryFailed(name, { reason: "provider" });
      console.warn(`[opencodex] Qoder model discovery for "${name}" failed [${live.error}]${live.detail ? `: ${live.detail}` : ""}; using stale/static catalog degradation.`);
    }
    const stale = getStaleCached(name, authorityIdentity);
    return observed(withConfiguredRetention(
      stale ? applyConfigHintsToCachedModels(name, prov, stale, contextCap, metadataModelIdCaseFold, captured.effectiveAlias) : configured,
    ), "degraded");
  }
  if (prov.adapter === "devin") {
    if (!apiKey) return observed(configured, "degraded");
    const cachedDevin = getFreshCached(name, ttlMs);
    if (cachedDevin) {
      return observed(
        withConfiguredRetention(applyConfigHintsToCachedModels(name, prov, cachedDevin)),
        "authoritative",
      );
    }
    if (isModelsFetchCoolingDown(name)) {
      const cooling = getStaleCached(name);
      return observed(
        withConfiguredRetention(
          cooling ? applyConfigHintsToCachedModels(name, prov, cooling) : configured,
        ),
        "degraded",
      );
    }
    const liveResult = await fetchDevinUsableModels({ apiKey, baseUrl: prov.baseUrl });
    if (liveResult.ok) {
      // Live catalog is the source of truth — use the discovered base models
      // directly, not a filtered subset of the static seed.
      //
      // That extends to the context window. Cognition publishes no window
      // anywhere, so the per-account catalog is the only first-party number,
      // and the shipped static table is a degraded-mode guess that was wrong
      // for nine of its eleven rows. The live value is applied first and the
      // config hints run after it, so an explicit per-model override and an
      // enabled Context cap still win — this only replaces the number nobody
      // chose.
      const result = liveResult.models.map((id) => {
        const liveWindow = liveResult.contextWindows[id];
        return {
          id,
          provider: name,
          ...(liveWindow ? { contextWindow: liveWindow } : {}),
          // The account catalog names the effort variants each base model has, so
          // its ladder is measured rather than assumed. Without this the entry
          // inherits the generic routed ladder and offers rungs the model rounds
          // away, and every client that keys an effort control off this field —
          // the Pi-shaped exports — renders no control at all.
          ...(liveResult.efforts[id]?.length ? { reasoningEfforts: liveResult.efforts[id] } : {}),
          // The account catalog's per-base supportsImages vote collapses to one
          // modalities value. It spreads before the hints so exact
          // modelCapabilities declarations, the legacy modelInputModalities
          // record and the vision-sidecar rewrite keep winning — the live
          // value survives only when none of them applies.
          ...(liveResult.inputModalities[id]?.length ? { inputModalities: liveResult.inputModalities[id] } : {}),
          ...catalogHintsFromProviderConfig(name, prov, id, contextCap, metadataModelIdCaseFold, captured.effectiveAlias),
        } as CatalogModel;
      });
      const forCache = withConfiguredRetention(result, { retainComboTargets: false });
      if (!setCached(name, forCache, Date.now(), cacheGeneration)) {
        return observed(withConfiguredRetention(configured), "degraded");
      }
      markProviderDiscoveryOk(name, liveResult.models.length);
      return observed(withConfiguredRetention(forCache), "authoritative");
    }
    if (isCurrentCacheGeneration()) {
      markModelsFetchFailure(name);
      markProviderDiscoveryFailed(name, { reason: liveResult.error === "auth" ? "provider" : "invalid_response" });
    }
    const stale = getStaleCached(name);
    return observed(
      withConfiguredRetention(stale ? applyConfigHintsToCachedModels(name, prov, stale) : configured),
      "degraded",
    );
  }
  if (prov.adapter === "cursor") {
    if (!apiKey) return observed(configured, "degraded");
    // Cursor uses a bespoke GetUsableModels RPC (not /models), returning the full effort-suffixed
    // variants this PLAN can use. Keep the base-model UX (the request builder appends the effort
    // suffix) but filter the static seed to the bases the account actually has — so models not on the
    // plan (e.g. claude-fable-5) drop out instead of failing ERROR_BAD_MODEL_NAME. Fall back to the seed.
    const cachedCursor = getFreshCached(name, ttlMs);
    if (cachedCursor) {
      return observed(
        withConfiguredRetention(applyConfigHintsToCachedModels(name, prov, cachedCursor, undefined, metadataModelIdCaseFold, captured.effectiveAlias)),
        "authoritative",
      );
    }
    if (isModelsFetchCoolingDown(name)) {
      const cooling = getStaleCached(name);
      return observed(
        withConfiguredRetention(
          cooling ? applyConfigHintsToCachedModels(name, prov, cooling, undefined, metadataModelIdCaseFold, captured.effectiveAlias) : configured,
        ),
        "degraded",
      );
    }
    const cursorFetch = (prov as OcxProviderConfig & { fetch?: typeof globalThis.fetch }).fetch;
    const liveResult = await fetchCursorUsableModels({
      apiKey,
      baseUrl: prov.baseUrl,
      upstreamHttpVersion: prov.upstreamHttpVersion,
      ...(cursorFetch ? { fetch: cursorFetch } : {}),
    });
    if (liveResult.ok) {
      const available = filterCursorConfiguredModelsByLiveDiscovery(configured, liveResult.models);
      const result = available.length > 0 ? available : configured;
      // Cache the discovery-filtered roster without combo retention so a later
      // gather can re-apply the current capture's retain set on read.
      const forCache = withConfiguredRetention(result, { retainComboTargets: false });
      if (!setCached(name, forCache, Date.now(), cacheGeneration)) {
        return observed(withConfiguredRetention(configured), "degraded");
      }
      // Publish roster-derived state only for a discovery the cache accepted: a stale
      // in-flight capture (generation revoked by a credential/config change) must not
      // overwrite the spelling or Max-Mode evidence of the newer one.
      recordLiveCursorClaudeModels(liveResult.models);
      // Live Max-Mode evidence feeds the umbrella resolver's ultra gate
      // (devlog 260828_cursor_umbrella_catalog; union with static evidence).
      recordLiveCursorMaxModeModels(liveResult.maxModeModels ?? []);
      markProviderDiscoveryOk(name, liveResult.models.length);
      return observed(withConfiguredRetention(forCache, { warnDrops: true }), "authoritative");
    }
    if (isCurrentCacheGeneration()) {
      markModelsFetchFailure(name);
      markProviderDiscoveryFailed(name, { reason: "provider" });
      console.warn(
        `[opencodex] Cursor model discovery for "${name}" failed [${liveResult.error}]${liveResult.detail ? `: ${liveResult.detail}` : ""}; using stale/static catalog degradation.`,
      );
    }
    const staleCursor = getStaleCached(name);
    return observed(
      withConfiguredRetention(
        staleCursor ? applyConfigHintsToCachedModels(name, prov, staleCursor, undefined, metadataModelIdCaseFold, captured.effectiveAlias) : configured,
      ),
      "degraded",
    );
  }
  if (prov.authMode === "oauth" && !apiKey) {
    // No usable token (logged out, or account marked needsReauth). Still surface the
    // configured static catalog so the GUI Models tab / rail counts are not empty —
    // matching Cursor's !apiKey → configured degradation and fetch-failure fallback.
    return observed(configured, "degraded");
  }
  const cloudCodeAssist = effectiveGoogleMode(name, prov) === "cloud-code-assist";
  const project = prov.project ?? auth.oauthProjectId;
  if (cloudCodeAssist && !project) return observed(configured, "degraded");
  const fresh = getFreshCached(name, ttlMs);
  if (fresh) {
    return observed(
      withConfiguredRetention(
        withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, fresh, contextCap, metadataModelIdCaseFold, captured.effectiveAlias)),
      ),
      "authoritative",
    ); // dedups Codex's frequent /v1/models polling within the TTL
  }
  if (isModelsFetchCoolingDown(name)) {
    // A recently-failed provider (unreachable API, missing proxy, bad key) must not re-pay the
    // fetch timeout on every catalog poll — the dashboard polls this path per page load.
    const stale = getStaleCached(name);
    return observed(
      withConfiguredRetention(
        stale
          ? withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, stale, contextCap, metadataModelIdCaseFold, captured.effectiveAlias))
          : failedDiscoveryConfigured,
      ),
      "degraded",
    );
  }
  const url = request.url;
  let headers = materializeCapturedHeaders(request, apiKey);
  // One Ollama authority contract: for canonical ollama-cloud/ollama-native rows, discovery
  // (/v1/models), enrichment (/api/show) and inference (/api/chat) must all materialize the
  // SAME effective credential/header authority. buildModelsRequest's generic tail writes the
  // generated Bearer AFTER configured headers, but the native inference adapter applies
  // provider.headers LAST (configured wins, case-insensitive collapse). Reapply the configured
  // provider headers here so the whole Ollama request family shares that one authority.
  if (ollamaShowEnrichable(name, prov)) {
    headers = applyConfiguredHeadersLast(headers, prov.headers);
  }
  const urlClass = new URL(url).hostname.endsWith("aiplatform.googleapis.com")
    ? "vertex-aiplatform"
    : "provider-models";
  const failedDiscoveryFallback = (
    failure: ProviderModelDiscoveryFailure,
  ): { models: CatalogModel[]; fallback: "stale" | "configured"; shouldLog: boolean } => {
    if (!isCurrentCacheGeneration()) {
      return {
        models: withConfiguredRetention(failedDiscoveryConfigured),
        fallback: "configured",
        shouldLog: false,
      };
    }
    // Decide logging BEFORE recording the new status, so we can compare against the prior one and
    // suppress an identical repeated failure (#395 log flood). The failure stays observable via the
    // discovery-status API regardless.
    const shouldLog = shouldLogDiscoveryFailure(name, failure);
    markModelsFetchFailure(name);
    markProviderDiscoveryFailed(name, failure);
    const stale = getStaleCached(name);
    return {
      models: withConfiguredRetention(
        stale
          ? withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, stale, contextCap, metadataModelIdCaseFold, captured.effectiveAlias))
          : failedDiscoveryConfigured,
      ),
      fallback: stale ? "stale" : "configured",
      shouldLog,
    };
  };
  try {
    // Canonical-URL TUN transparency for Clash/Surge/Mihomo fake-IP DNS:
    // `isRegistryModelDiscoveryUrl` proves the FINAL request URL is the
    // registry's own fixed discovery URL, so a purely-benchmark DNS answer may
    // be pin-connected through the intercepting TUN without proxy env. The
    // proof is on the URL — not the provider name — because an OAuth/forward
    // name matches any baseUrl by design. Retargeted or renamed custom rows
    // fetch a different URL and keep the rejection.
    const outboundDependencies = { isCanonicalUrl: isRegistryModelDiscoveryUrl };
    const res = request.method === "POST"
      ? await providerOutboundPost(name, prov, url, {
        headers,
        body: JSON.stringify({ project }),
        signal: AbortSignal.timeout(8000),
      }, outboundDependencies)
      : await providerOutboundGet(name, prov, url, {
        headers,
        signal: AbortSignal.timeout(8000),
      }, outboundDependencies);
    const redirectError = await providerRedirectError(res, url);
    if (redirectError) {
      const { models, fallback, shouldLog } = failedDiscoveryFallback({ reason: "http", httpStatus: res.status });
      if (shouldLog) {
        console.warn(
          `[opencodex] Provider model discovery for "${name}" ${redirectError} [urlClass=${urlClass}, fallback=${fallback}].`,
        );
      }
      return observed(models, "degraded");
    }
    if (!res.ok) {
      const { models, fallback, shouldLog } = failedDiscoveryFallback({ reason: "http", httpStatus: res.status });
      if (shouldLog) {
        console.warn(
          `[opencodex] Provider model discovery for "${name}" failed with HTTP ${res.status} [urlClass=${urlClass}, fallback=${fallback}].`,
        );
      }
      return observed(models, "degraded");
    }

    const contentType = (
      res.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "missing"
    ).slice(0, 80);
    const bounded = await readBoundedDiscoveryJson(res, discovery.maxResponseBytes);
    if (!bounded.ok) {
      const { models, fallback, shouldLog } = failedDiscoveryFallback({ reason: "invalid_response" });
      const diagnostic = bounded.reason === "response_too_large"
        ? `exceeded the ${discovery.maxResponseBytes}-byte response limit`
        : contentType === "application/json" || contentType.endsWith("+json")
          ? "returned invalid JSON in a 2xx response"
          : "returned a non-JSON 2xx response";
      if (shouldLog) {
        console.warn(
          `[opencodex] Provider model discovery for "${name}" ${diagnostic} [status=${res.status}, contentType=${contentType}, urlClass=${urlClass}, fallback=${fallback}].`,
        );
      }
      return observed(models, "degraded");
    }
    const antigravity = cloudCodeAssist
      ? parseAntigravityAvailableModels(bounded.value, discovery.maxModels)
      : undefined;
    if (cloudCodeAssist && !antigravity) {
      const { models, fallback, shouldLog } = failedDiscoveryFallback({ reason: "invalid_response" });
      if (shouldLog) {
        console.warn(
          `[opencodex] Provider model discovery for "${name}" returned malformed CCA model data [status=${res.status}, contentType=${contentType}, urlClass=${urlClass}, fallback=${fallback}].`,
        );
      }
      return observed(models, "degraded");
    }
    if (antigravity) {
      const live = antigravity.map(model => applyProviderConfigHints(name, prov, {
        id: model.id,
        provider: name,
        // CCA only exposes a numeric thinking budget. Until the adapter owns an exact Codex
        // effort-to-wire mapping for a newly discovered model, do not advertise a false ladder.
        reasoningEfforts: [],
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
      }, contextCap, metadataModelIdCaseFold, captured.effectiveAlias));
      const forCache = withConfiguredRetention(live, { retainComboTargets: false });
      if (!setCached(name, forCache, Date.now(), cacheGeneration)) {
        return observed(withConfiguredRetention(configured), "degraded");
      }
      registerAntigravityDiscoveredWireModels(prov.baseUrl, antigravity, {
        provider: name,
        cacheGeneration,
      });
      markProviderDiscoveryOk(name, live.length);
      return observed(withConfiguredRetention(forCache, { warnDrops: true }), "authoritative");
    }
    const googleAiStudio = effectiveGoogleMode(name, prov) === "ai-studio"
      ? extractGoogleAiStudioModelItems(bounded.value, discovery.maxModels)
      : undefined;
    // Native /v1beta/models wins; a google row served by an OpenAI-compatible
    // gateway keeps the generic data[] / top-level-array contract.
    const extracted = googleAiStudio?.ok
      ? googleAiStudio
      : extractProviderModelItems(bounded.value, discovery);
    if (!extracted.ok) {
      const { models, fallback, shouldLog } = failedDiscoveryFallback({ reason: "invalid_response" });
      const diagnostic: Record<ModelDiscoveryResponseFailure, string> = {
        response_too_large: "returned an oversized 2xx response",
        invalid_json: "returned invalid JSON in a 2xx response",
        invalid_shape: "returned malformed 2xx data",
        too_many_models: `exceeded the ${discovery.maxModels}-row model limit`,
      };
      if (shouldLog) {
        console.warn(
          `[opencodex] Provider model discovery for "${name}" ${diagnostic[extracted.reason]} [status=${res.status}, contentType=${contentType}, urlClass=${urlClass}, fallback=${fallback}].`,
        );
      }
      return observed(models, "degraded");
    }
    const items = extracted.items;
    // Ollama Cloud enrichment: /v1/models carries no per-model context or capability metadata,
    // so a newly announced id would otherwise publish generic defaults. /api/show fills that
    // per model, fail-soft, bounded, and cached with this gather's result. Explicit configured
    // metadata keeps its normal precedence (applyProviderConfigHints applies the discovered
    // window only where exact config is absent, and the provider context cap still caps it).
    const showEnrichment = ollamaShowEnrichable(name, prov)
      ? await fetchOllamaShowEnrichment({
        headers,
        discoveryUrl: request.url,
        modelIds: items.map(m => m.id),
        provider: prov,
      }).catch(() => undefined)
      : undefined;
    const live = items.map(m => {
      const ownedBy = boundedOwnedBy(m.owned_by);
      // Precedence: the authoritative /v1/models row wins; /api/show fills only metadata the
      // models-API row does not carry. applyProviderConfigHints then applies explicit
      // configured metadata over both, and the provider context cap still caps the result.
      const modelsApiHints = catalogHintsFromModelsApiItem(name, m);
      const show = showEnrichment?.metadata.get(m.id);
      const discoveredHints = {
        ...modelsApiHints,
        ...(modelsApiHints.contextWindow === undefined && show?.contextWindow !== undefined
          ? { contextWindow: show.contextWindow }
          : {}),
        ...(modelsApiHints.inputModalities === undefined && show?.nativeVision === true
          ? { inputModalities: ["text", "image"] as string[] }
          : {}),
      };
      return applyProviderConfigHints(name, prov, {
        id: m.id,
        provider: name,
        ...(ownedBy ? { owned_by: ownedBy } : {}),
        ...discoveredHints,
      }, contextCap, metadataModelIdCaseFold, captured.effectiveAlias);
    })
      .filter(m => shouldExposeProviderModel(name, m.id));
    // Capture the count BEFORE the alias/configured augmentation below pushes extra rows into
    // `live`; otherwise configured entries would be reported as discovered ones.
    const liveModelCount = live.length;
    // Dated-release aliases + configured retention (compat allow-list, combo targets,
    // Vertex default). Cache without combo retention so a later gather re-applies the
    // current capture's retain set on read (warm-cache OCX-111 / #1308).
    const forCache = withConfiguredRetention(live, { retainComboTargets: false });
    const returned = withConfiguredRetention(forCache, { warnDrops: true });
    const droppedConfiguredIds = configured
      .map(model => model.id)
      .filter(id => !returned.some(model => model.id === id));
    if (returned.length === 0 && name !== OPENAI_API_PROVIDER_ID) {
      console.warn(
        `[opencodex] Provider model discovery for "${name}" returned an authoritative empty catalog; ${droppedConfiguredIds.length > 0 ? `dropping configured model ids: ${droppedConfiguredIds.join(", ")}` : "no models will be exposed"}.`,
      );
    }
    if (!setCached(name, forCache, Date.now(), cacheGeneration)) {
      return observed(withConfiguredRetention(configured), "degraded");
    }
    markProviderDiscoveryOk(name, liveModelCount);
    return observed(returned, "authoritative");
  } catch (error) {
    if (error instanceof ProviderOutboundPolicyError) {
      const { models, fallback, shouldLog } = failedDiscoveryFallback({ reason: "blocked" });
      if (shouldLog) {
        console.warn(
          `[opencodex] Provider model discovery for "${name}" was blocked by destination policy: ${error.message} [urlClass=${urlClass}, fallback=${fallback}].`,
        );
      }
      return observed(models, "degraded");
    }
    const { models, fallback, shouldLog } = failedDiscoveryFallback({ reason: "network" });
    if (shouldLog) {
      console.warn(
        `[opencodex] Provider model discovery for "${name}" threw ${error instanceof Error ? error.name : "unknown"} [urlClass=${urlClass}, fallback=${fallback}].`,
      );
    }
    return observed(models, "degraded");
  }
}

export async function fetchProviderModels(
  name: string,
  prov: OcxProviderConfig,
  ttlMs: number,
  contextCap?: number,
): Promise<CatalogModel[]> {
  const captured = captureProviderGather(name, prov, refreshingModelsAuthResolver);
  return (await fetchProviderModelsWithAuth(
    captured,
    ttlMs,
    contextCap,
    refreshingModelsAuthResolver,
  )).models;
}
