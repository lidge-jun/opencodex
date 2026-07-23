import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { atomicWriteFile, expandUserPath, getConfigDir, websocketsEnabled } from "../../config";
import { CODEX_CONFIG_PATH, CODEX_MODELS_CACHE_PATH, DEFAULT_CATALOG_PATH, readRootTomlString, resolveCodexConfigPath } from "../paths";
import {
  clearModelCache,
  clearProviderDiscoveryStatus,
  DEFAULT_MODEL_CACHE_TTL_MS,
  getFreshCached,
  getStaleCached,
  isModelsFetchCoolingDown,
  markModelsFetchFailure,
  markProviderDiscoveryFailed,
  markProviderDiscoveryOk,
  setCached,
  type ProviderModelDiscoveryFailure,
} from "../model-cache";
import { buildModelsRequest, resolveModelsAuthToken } from "../../oauth";
import type { OcxConfig, OcxProviderConfig } from "../../types";
import { modelInList } from "../../types";
import { CODEX_REASONING_LEVELS, codexEffortRank, configuredReasoningEfforts, modelRecordValue, sanitizeCodexReasoningEfforts } from "../../reasoning-effort";
import { getJawcodeModelMetadata, getJawcodeModelMetadataCaseInsensitive, listJawcodeModelMetadata, resolveJawcodeProvider } from "../../generated/jawcode-model-metadata";
import { enrichProviderFromRegistry, shouldCaseFoldMetadataModelId } from "../../providers/derive";
import { getProviderRegistryEntry } from "../../providers/registry";
import { applyProviderContextCap, providerContextCap } from "../../providers/context-cap";
import { routedSlug, slugEquals, slugsEquivalent } from "../../providers/slug-codec";
import { CODEX_GPT5_IDENTITY_LINE } from "../../adapters/identity";
import { filterCursorConfiguredModelsByLiveDiscovery } from "../../adapters/cursor/discovery";
import { fetchCursorUsableModels } from "../../adapters/cursor/live-models";
import { isCanonicalOpenAiForwardProvider, OPENAI_API_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import {
  COMBO_NAMESPACE,
  comboModelId,
  getCombo,
  listComboIds,
  targetKey,
} from "../../combos";
import type { NormalizedComboConfig } from "../../combos/types";
import { providerDestinationResolvedError } from "../../lib/destination-policy";
import { redactSecretString } from "../../lib/redact";
import upstreamModelsSnapshot from "../data/upstream-models.json";


import { JAWCODE_CATALOG_AUGMENT_PROVIDERS, catalogModelSlug, shouldExposeRoutedModel } from "./parsing";
import type { CatalogModel } from "./parsing";
import { disabledNativeSlugs, hasComboTargets, nativeInputModalities, nativeOpenAiContextWindow, nativeOpenAiSlugs, nativeParallelToolCalls, nativeReasoningEfforts } from "./metadata";
import { deriveComboCatalogModel, normalizedOpenAiApiSignature, openAiApiCollisionWarnings, warnUncataloguedComboOnce } from "./aggregation";

type OcxProviderConfigWithReasoningSummaries = OcxProviderConfig & {
  modelSupportsReasoningSummaries?: Record<string, boolean>;
};

export type ProviderModelsApiItem = {
  id: string;
  owned_by?: string;
  context_length?: number;
  max_model_len?: number;
  metadata?: {
    capabilities?: Record<string, unknown>;
    limits?: Record<string, unknown>;
  };
};

/** Normalize the common model-catalog envelopes without weakening malformed-response fallback. */
export function parseProviderModelsApiItems(value: unknown, allowModelsEnvelope = false): ProviderModelsApiItem[] | null {
  const rows = Array.isArray(value)
    ? value
    : value !== null && typeof value === "object"
      ? (Array.isArray((value as { data?: unknown }).data)
        ? (value as { data: unknown[] }).data
        : allowModelsEnvelope && Array.isArray((value as { models?: unknown }).models)
          ? (value as { models: unknown[] }).models
          : null)
      : null;
  if (!rows) return null;

  const normalized: ProviderModelsApiItem[] = [];
  for (const row of rows) {
    if (typeof row === "string" && row.trim()) {
      normalized.push({ id: row.trim() });
      continue;
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
    const item = row as Record<string, unknown>;
    const rawId = typeof item.id === "string" ? item.id
      : typeof item.name === "string" ? item.name
      : typeof item.model === "string" ? item.model
      : "";
    const id = rawId.trim()
      .replace(/^models\//, "")
      .replace(/^accounts\/fireworks\/models\//, "");
    if (!id) return null;
    const contextLength = [
      item.context_length,
      item.context_window,
      item.contextWindow,
      item.inputTokenLimit,
      item.max_context_length,
      item.max_model_len,
    ].find(candidate => typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) as number | undefined;
    normalized.push({
      id,
      ...(typeof item.owned_by === "string" ? { owned_by: item.owned_by } : {}),
      ...(contextLength ? { context_length: contextLength } : {}),
      ...(item.metadata !== null && typeof item.metadata === "object" && !Array.isArray(item.metadata)
        ? { metadata: item.metadata as ProviderModelsApiItem["metadata"] }
        : {}),
    });
  }
  return normalized;
}

export function configuredContextWindow(prov: OcxProviderConfig, id: string): number | undefined {
  const configured = modelRecordValue(prov.modelContextWindows, id) ?? prov.contextWindow;
  return typeof configured === "number" && configured > 0 ? configured : undefined;
}

export function configuredInputModalities(prov: OcxProviderConfig, id: string): string[] | undefined {
  const modalities = modelRecordValue(prov.modelInputModalities, id);
  return Array.isArray(modalities) && modalities.length > 0 ? [...modalities] : undefined;
}

export function configuredMaxInputTokens(prov: OcxProviderConfig, id: string): number | undefined {
  const configured = modelRecordValue(prov.modelMaxInputTokens, id);
  return typeof configured === "number" && configured > 0 ? configured : undefined;
}

export function applyProviderConfigHints(name: string, prov: OcxProviderConfig, model: CatalogModel, providerCap?: number): CatalogModel {
  void name;
  const configuredCap = configuredContextWindow(prov, model.id);
  const configuredMaxInput = configuredMaxInputTokens(prov, model.id);
  let inputModalities = configuredInputModalities(prov, model.id);
  // Vision-sidecar coverage: `noVisionModels` marks models whose images the PROXY describes
  // (src/vision/index.ts). The catalog must still advertise image input for them — the Codex app
  // gates attachments client-side on input_modalities, and a text-only entry would block images
  // before the sidecar ever runs ("This model does not support image inputs").
  if (modelInList(prov.noVisionModels, model.id)) {
    const base = inputModalities ?? model.inputModalities ?? ["text"];
    inputModalities = base.includes("image") ? [...base] : [...base, "image"];
  }
  const reasoningEfforts = configuredReasoningEfforts(prov, model.id);
  const defaultReasoningEffort = modelRecordValue(prov.modelDefaultReasoningEfforts, model.id) ?? model.defaultReasoningEffort;
  const supportsReasoningSummaries = modelRecordValue(
    (prov as OcxProviderConfigWithReasoningSummaries).modelSupportsReasoningSummaries,
    model.id,
  );
  const hinted = {
    ...model,
    ...(configuredCap !== undefined
      ? {
        contextWindow: typeof model.contextWindow === "number" && model.contextWindow > 0
          ? Math.min(model.contextWindow, configuredCap)
          : configuredCap,
      }
      : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
    ...(configuredMaxInput !== undefined
      ? {
        maxInputTokens: typeof model.maxInputTokens === "number" && model.maxInputTokens > 0
          ? Math.min(model.maxInputTokens, configuredMaxInput)
          : configuredMaxInput,
      }
      : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(typeof supportsReasoningSummaries === "boolean" ? { supportsReasoningSummaries } : {}),
    ...(prov.adapter === "kiro" ? { supportsVerbosity: false } : {}),
    // Default-on for openai-chat providers (explicit false opts out); other adapters
    // advertise only on explicit opt-in.
    ...(prov.parallelToolCalls === true || (prov.adapter === "openai-chat" && prov.parallelToolCalls !== false)
      ? { parallelToolCalls: true }
      : {}),
  };
  const capped = applyProviderContextCap(hinted.contextWindow, providerCap);
  if (providerCap !== undefined && capped !== hinted.contextWindow) {
    return { ...hinted, contextWindow: capped, contextCap: providerCap, contextCapped: true };
  }
  return providerCap !== undefined ? { ...hinted, contextCap: providerCap, contextCapped: false } : hinted;
}

export function catalogHintsFromProviderConfig(name: string, prov: OcxProviderConfig, id: string, contextCap?: number): Partial<CatalogModel> {
  const hinted = applyProviderConfigHints(name, prov, { id, provider: name }, contextCap);
  const { provider: _provider, id: _id, ...hints } = hinted;
  return hints;
}

export function applyConfigHintsToCachedModels(name: string, prov: OcxProviderConfig, models: CatalogModel[], contextCap?: number): CatalogModel[] {
  return models.map(model => applyProviderConfigHints(name, prov, model, contextCap));
}

export function isDatedVariantId(liveId: string, configuredId: string): boolean {
  if (!liveId.startsWith(`${configuredId}-`)) return false;
  return /^\d{8}$/.test(liveId.slice(configuredId.length + 1));
}

export const lastDropWarnSignature = new Map<string, string>();

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
    "grok-4.20-0309-reasoning",
    "grok-4.20-0309-non-reasoning",
    "grok-build-0.1",
    "grok-composer-2.5-fast",
  ]),
};

export function warnDroppedConfiguredIdsOnce(name: string, droppedConfiguredIds: string[]): void {
  const signature = [...droppedConfiguredIds].sort().join(",");
  if (lastDropWarnSignature.get(name) === signature) return;
  lastDropWarnSignature.set(name, signature);
  console.warn(
    `[opencodex] Provider model discovery for "${name}" omitted configured model ids; dropping them from the authoritative live catalog: ${droppedConfiguredIds.join(", ")}.`,
  );
}

export function isGlm52ModelId(id: string): boolean {
  const normalized = id.toLowerCase();
  return normalized === "glm-5.2" || normalized === "glm-5.2[1m]";
}

export function catalogHintsFromModelsApiItem(providerName: string, item: ProviderModelsApiItem): Partial<CatalogModel> {
  const capabilities = item.metadata?.capabilities;
  const limits = item.metadata?.limits;
  const contextWindow =
    typeof limits?.max_context_length === "number" ? limits.max_context_length
      : typeof item.context_length === "number" ? item.context_length
      : typeof item.max_model_len === "number" ? item.max_model_len
        : undefined;
 const reasoningEfforts = capabilities && typeof capabilities.reasoning_effort === "boolean"
   ? (capabilities.reasoning_effort
     ? ((providerName === "neuralwatt" || providerName === "zai") && isGlm52ModelId(item.id)
       ? ["low", "medium", "high", "xhigh", "max"]
       : ["low", "medium", "high", "xhigh"])
     : [])
   : undefined;
 const inputModalities = capabilities && typeof capabilities.vision === "boolean"
    ? (capabilities.vision ? ["text", "image"] : ["text"])
    : undefined;
  return {
    ...(contextWindow && contextWindow > 0 ? { contextWindow } : {}),
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
    ...(inputModalities ? { inputModalities } : {}),
  };
}

export async function fetchProviderModels(name: string, prov: OcxProviderConfig, ttlMs: number, contextCap?: number): Promise<CatalogModel[]> {
  if (prov.authMode === "forward") return []; // ChatGPT backend has no /models
  const apiKey = await resolveModelsAuthToken(name, prov);
  const seedVertexDefault = prov.adapter === "google"
    && prov.googleMode === "vertex"
    && (prov.models?.length ?? 0) === 0
    && Boolean(prov.defaultModel);
  const configuredIds = seedVertexDefault && prov.defaultModel ? [prov.defaultModel] : (prov.models ?? []);
  const configured: CatalogModel[] = configuredIds.map(id => ({
    id,
    provider: name,
    ...catalogHintsFromProviderConfig(name, prov, id, contextCap),
  }));
  // A configured default is a real callable selector and must remain discoverable when a
  // compatible provider's live /models request fails (issue #308). Keep this separate from the
  // explicit static list: `liveModels: false` + empty `models[]` intentionally publishes zero
  // rows, while a failed live discovery may degrade to the default selector.
  const failedDiscoveryConfigured = configured.length > 0 || !prov.defaultModel || prov.adapter !== "anthropic"
    ? configured
    : [{
      id: prov.defaultModel,
      provider: name,
      ...catalogHintsFromProviderConfig(name, prov, prov.defaultModel, contextCap),
    }];
  const vertexDefaultSeed = seedVertexDefault ? configured[0] : undefined;
  const withVertexDefaultSeed = (models: CatalogModel[]): CatalogModel[] => (
    vertexDefaultSeed && !models.some(model => model.id === vertexDefaultSeed.id)
      ? [...models, vertexDefaultSeed]
      : models
  );
  if (prov.adapter === "cursor") {
    if (prov.liveModels === false) {
      clearProviderDiscoveryStatus(name);
      return configured;
    }
    if (!apiKey) return configured;
    // Cursor uses a bespoke GetUsableModels RPC (not /models), returning the full effort-suffixed
    // variants this PLAN can use. Keep the base-model UX (the request builder appends the effort
    // suffix) but filter the static seed to the bases the account actually has — so models not on the
    // plan (e.g. claude-fable-5) drop out instead of failing ERROR_BAD_MODEL_NAME. Fall back to the seed.
    const cachedCursor = getFreshCached(name, ttlMs);
    if (cachedCursor) return applyConfigHintsToCachedModels(name, prov, cachedCursor);
    if (isModelsFetchCoolingDown(name)) {
      const cooling = getStaleCached(name);
      return cooling ? applyConfigHintsToCachedModels(name, prov, cooling) : configured;
    }
    const liveResult = await fetchCursorUsableModels({ apiKey, baseUrl: prov.baseUrl });
    if (liveResult.ok) {
      const available = filterCursorConfiguredModelsByLiveDiscovery(configured, liveResult.models);
      const result = available.length > 0 ? available : configured;
      markProviderDiscoveryOk(name);
      setCached(name, result);
      return result;
    }
    markModelsFetchFailure(name);
    markProviderDiscoveryFailed(name, { reason: "provider" });
    console.warn(
      `[opencodex] Cursor model discovery for "${name}" failed [${liveResult.error}]${liveResult.detail ? `: ${liveResult.detail}` : ""}; using stale/static catalog degradation.`,
    );
    const staleCursor = getStaleCached(name);
    return staleCursor ? applyConfigHintsToCachedModels(name, prov, staleCursor) : configured;
  }
  if (prov.authMode === "oauth" && !apiKey) {
    // No usable token (logged out, or account marked needsReauth). Still surface the
    // configured static catalog so the GUI Models tab / rail counts are not empty —
    // matching Cursor's !apiKey → configured degradation and fetch-failure fallback.
    return configured;
  }
  if (prov.liveModels === false) {
    clearProviderDiscoveryStatus(name);
    return configured;
  }
  const fresh = getFreshCached(name, ttlMs);
  if (fresh) return withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, fresh, contextCap)); // dedups Codex's frequent /v1/models polling within the TTL
  if (isModelsFetchCoolingDown(name)) {
    // A recently-failed provider (unreachable API, missing proxy, bad key) must not re-pay the
    // fetch timeout on every catalog poll — the dashboard polls this path per page load.
    const stale = getStaleCached(name);
    return stale ? withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, stale, contextCap)) : failedDiscoveryConfigured;
  }
  const { url, headers } = buildModelsRequest(prov, apiKey, name);
  const urlClass = new URL(url).hostname.endsWith("aiplatform.googleapis.com")
    ? "vertex-aiplatform"
    : "provider-models";
  const failedDiscoveryFallback = (
    failure: ProviderModelDiscoveryFailure,
  ): { models: CatalogModel[]; fallback: "stale" | "configured" } => {
    markModelsFetchFailure(name);
    markProviderDiscoveryFailed(name, failure);
    const stale = getStaleCached(name);
    return {
      models: stale
        ? withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, stale, contextCap))
        : failedDiscoveryConfigured,
      fallback: stale ? "stale" : "configured",
    };
  };
  try {
    const destinationError = await providerDestinationResolvedError(name, {
      baseUrl: url,
      allowPrivateNetwork: prov.allowPrivateNetwork,
    });
    if (destinationError) {
      const { models, fallback } = failedDiscoveryFallback({ reason: "blocked" });
      console.warn(
        `[opencodex] Provider model discovery for "${name}" was blocked by destination policy: ${destinationError} [urlClass=${urlClass}, fallback=${fallback}].`,
      );
      return models;
    }

    const res = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      const { models, fallback } = failedDiscoveryFallback({ reason: "http", httpStatus: res.status });
      console.warn(
        `[opencodex] Provider model discovery for "${name}" failed with HTTP ${res.status} [urlClass=${urlClass}, fallback=${fallback}].`,
      );
      return models;
    }

    const contentType = (
      res.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "missing"
    ).slice(0, 80);
    const body = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(body) as unknown;
    } catch {
      const { models, fallback } = failedDiscoveryFallback({ reason: "invalid_response" });
      const diagnostic = contentType === "application/json" || contentType.endsWith("+json")
        ? "returned invalid JSON in a 2xx response"
        : "returned a non-JSON 2xx response";
      console.warn(
        `[opencodex] Provider model discovery for "${name}" ${diagnostic} [status=${res.status}, contentType=${contentType}, urlClass=${urlClass}, fallback=${fallback}].`,
      );
      return models;
    }
    const allowsModelsEnvelope = (prov.adapter === "google" && (prov.googleMode ?? "ai-studio") === "ai-studio")
      || new URL(url).pathname.replace(/\/+$/, "").endsWith("/api/tags");
    const items = parseProviderModelsApiItems(json, allowsModelsEnvelope);
    if (!items) {
      const { models, fallback } = failedDiscoveryFallback({ reason: "invalid_response" });
      console.warn(
        `[opencodex] Provider model discovery for "${name}" returned malformed 2xx data [status=${res.status}, contentType=${contentType}, urlClass=${urlClass}, fallback=${fallback}].`,
      );
      return models;
    }
    const live = items.map(m => applyProviderConfigHints(name, prov, {
      id: m.id,
      provider: name,
      owned_by: m.owned_by,
      ...catalogHintsFromModelsApiItem(name, m),
    }, contextCap))
      .filter(m => shouldExposeProviderModel(name, m.id));
    const liveIds = new Set(live.map(m => m.id));
    // Dated-release aliases (Anthropic pattern): older models may appear in the live catalog
    // ONLY under their dated id (claude-haiku-4-5-20251001) while the config names the
    // API-valid alias (claude-haiku-4-5). Such aliases are real, callable models — keep them
    // in the authoritative catalog (alias id, hints from the dated live entry) instead of
    // dropping them and warning on every poll.
    const droppedConfiguredIds: string[] = [];
    for (const m of configured) {
      if (liveIds.has(m.id)) continue;
      const dated = live.find(l => isDatedVariantId(l.id, m.id));
      if (dated) {
        // Reapply config hints so alias-keyed overrides (modelContextWindows etc.) win.
        live.push(applyProviderConfigHints(name, prov, { ...dated, id: m.id }, contextCap));
      } else if (seedVertexDefault || shouldRetainConfiguredProviderModel(name, m.id)) {
        live.push(m);
      } else {
        droppedConfiguredIds.push(m.id);
      }
    }
    if (live.length === 0 && name !== OPENAI_API_PROVIDER_ID) {
      console.warn(
        `[opencodex] Provider model discovery for "${name}" returned an authoritative empty catalog; ${droppedConfiguredIds.length > 0 ? `dropping configured model ids: ${droppedConfiguredIds.join(", ")}` : "no models will be exposed"}.`,
      );
    } else if (droppedConfiguredIds.length > 0
      && name !== OPENAI_API_PROVIDER_ID
      && !QUIET_AUTHORITATIVE_CATALOG_PROVIDERS.has(name)) {
      warnDroppedConfiguredIdsOnce(name, droppedConfiguredIds);
    }
    markProviderDiscoveryOk(name);
    setCached(name, live);
    return live;
  } catch (error) {
    const { models, fallback } = failedDiscoveryFallback({ reason: "network" });
    console.warn(
      `[opencodex] Provider model discovery for "${name}" threw ${error instanceof Error ? error.name : "unknown"} [urlClass=${urlClass}, fallback=${fallback}].`,
    );
    return models;
  }
}

export function shouldExposeProviderModel(providerName: string, modelId: string): boolean {
  if (providerName === "opencode-free") return modelId === "big-pickle" || modelId.endsWith("-free");
  return true;
}

export function shouldRetainConfiguredProviderModel(providerName: string, modelId: string): boolean {
  if (CALLABLE_CONFIGURED_COMPATIBILITY_MODELS[providerName]?.has(modelId)) return true;
  if (providerName === "opencode-free") return modelId === "big-pickle" || modelId.endsWith("-free");
  return false;
}

export function filterCatalogVisibleModels(
  models: CatalogModel[],
  config: Pick<OcxConfig, "disabledModels" | "providers">,
): CatalogModel[] {
  const disabled = new Set(config.disabledModels ?? []);
  const allowByProvider = new Map<string, Set<string>>();
  for (const [name, prov] of Object.entries(config.providers)) {
    const sel = prov.selectedModels;
    if (Array.isArray(sel) && sel.length > 0) allowByProvider.set(name, new Set(sel));
  }
  return models.filter(m => {
    // disabledModels may be stored raw (canonical) or encoded (legacy UI writes).
    for (const stored of disabled) {
      // Combo management stores the public alias, while canonical `combo/<id>` references
      // remain valid for backward compatibility through slugEquals below.
      if (m.alias !== undefined && stored === catalogModelSlug(m)) return false;
      if (slugEquals(stored, m.provider, m.id)) return false;
    }
    const allow = allowByProvider.get(m.provider);
    return !allow || allow.has(m.id);
  });
}

export async function gatherRoutedModels(config: OcxConfig): Promise<CatalogModel[]> {
  const ttlMs = config.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS;
  // Persisted provider entries can predate newer registry fields (noVisionModels,
  // modelInputModalities, ...). The ROUTER merges registry seeds at request time
  // (routedProviderConfig), so the proxy behaves correctly — the catalog listing must see the
  // same merged view or its advertisements drift from actual proxy behavior (e.g. a
  // vision-sidecar model advertised text-only, blocking image attachments app-side).
  // Enrich a CLONE: hydrated defaults must never leak into the persisted config.
  const activeProviders = Object.entries(config.providers)
    .filter(([, prov]) => prov.disabled !== true)
    .map(([name, prov]): [string, OcxProviderConfig] => {
      const enriched = { ...prov };
      enrichProviderFromRegistry(name, enriched);
      return [name, enriched];
    });
  const lists = await Promise.all(
    activeProviders.map(([name, prov]) => fetchProviderModels(name, prov, ttlMs, providerContextCap(config, name))),
  );
  const apiAugmented = augmentRoutedModelsWithRegistryOpenAiApiRows(lists.flat(), config);
  const all = augmentRoutedModelsWithJawcodeMetadata(apiAugmented, activeProviders.map(([name]) => name), config.providers, config)
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
    for (const slug of nativeOpenAiSlugs()) {
      if (disabled.has(slug)) continue;
      const contextWindow = nativeOpenAiContextWindow(slug);
      if (contextWindow === undefined) continue;
      const synthetic: CatalogModel = {
        provider: "openai",
        id: slug,
        owned_by: "openai",
        contextWindow,
        maxInputTokens: contextWindow,
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
  for (const id of listComboIds(config)) {
    const combo = getCombo(config, id);
    if (!combo) continue;
    const members = combo.targets
      .map(target => memberByKey.get(targetKey(target)))
      .filter((member): member is CatalogModel => member !== undefined);
    const derived = deriveComboCatalogModel(id, combo, members);
    if (derived) all.push(derived);
    else warnUncataloguedComboOnce(id, combo, members);
  }
  all.sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)));
  const customModels = (config.customModels ?? []).map(cm => {
    const provider = config.providers[cm.provider] as OcxProviderConfigWithReasoningSummaries | undefined;
    const supportsReasoningSummaries = modelRecordValue(provider?.modelSupportsReasoningSummaries, cm.modelId);
    return {
      id: cm.modelId,
      provider: cm.provider,
      // Display-only label: never feeds routing (customModels are keyed by routedSlug below).
      ...(cm.displayName ? { displayName: cm.displayName } : {}),
      ...(cm.contextWindow ? { contextWindow: cm.contextWindow } : {}),
      ...(cm.inputModalities ? { inputModalities: cm.inputModalities } : {}),
      ...(typeof supportsReasoningSummaries === "boolean" ? { supportsReasoningSummaries } : {}),
    };
  });
  // Custom rows override discovered rows that encode to the same Codex-facing slug.
  const customKeys = new Set(customModels.map(c => routedSlug(c.provider, c.id)));
  const deduped = all.filter(m => !customKeys.has(routedSlug(m.provider, m.id)));
  return [...deduped, ...customModels];
}

export function augmentRoutedModelsWithRegistryOpenAiApiRows(
  models: CatalogModel[],
  config: OcxConfig,
): CatalogModel[] {
  const configured = config.providers[OPENAI_API_PROVIDER_ID];
  if (!configured || configured.disabled === true) return models;
  const entry = getProviderRegistryEntry(OPENAI_API_PROVIDER_ID);
  if (!entry?.models) return models;

  const existingById = new Map(
    models.filter(model => model.provider === OPENAI_API_PROVIDER_ID).map(model => [model.id, model]),
  );
  const trustedRows = entry.models.map((id): CatalogModel => {
    const officialContext = entry.modelContextWindows?.[id];
    const officialMaxInput = entry.modelMaxInputTokens?.[id];
    const userContext = configured.modelContextWindows?.[id] ?? configured.contextWindow;
    const userMaxInput = configured.modelMaxInputTokens?.[id];
    const providerCap = providerContextCap(config, OPENAI_API_PROVIDER_ID);
    const contextWindow = typeof officialContext === "number"
      ? Math.min(officialContext, userContext ?? officialContext, providerCap ?? officialContext)
      : undefined;
    const maxInputTokens = typeof officialMaxInput === "number"
      ? Math.min(officialMaxInput, userMaxInput ?? officialMaxInput)
      : undefined;
    return {
      provider: OPENAI_API_PROVIDER_ID,
      id,
      owned_by: OPENAI_API_PROVIDER_ID,
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxInputTokens ? { maxInputTokens } : {}),
      ...(entry.modelInputModalities?.[id] ? { inputModalities: [...entry.modelInputModalities[id]!] } : {}),
      ...(entry.modelReasoningEfforts?.[id] ? { reasoningEfforts: [...entry.modelReasoningEfforts[id]!] } : {}),
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

export function augmentRoutedModelsWithJawcodeMetadata(
  models: CatalogModel[],
  providerNames: string[],
  providers?: Record<string, OcxProviderConfig>,
  caps?: Pick<OcxConfig, "providerContextCaps">,
): CatalogModel[] {
  const out = [...models];
  const seen = new Set(out.map(m => `${m.provider}/${m.id}`));
  for (const provider of providerNames) {
    if (!JAWCODE_CATALOG_AUGMENT_PROVIDERS.has(provider)) continue;
    if (providers?.[provider]?.liveModels === false) continue;
    const jawcodeProvider = resolveJawcodeProvider(provider);
    if (!jawcodeProvider) continue;
    for (const meta of listJawcodeModelMetadata(jawcodeProvider)) {
      const key = `${provider}/${meta.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const contextCap = caps ? providerContextCap(caps, provider) : undefined;
      const model: CatalogModel = {
        provider,
        id: meta.id,
        owned_by: provider,
        ...(typeof meta.contextWindow === "number" && meta.contextWindow > 0 ? { contextWindow: meta.contextWindow } : {}),
        ...(Array.isArray(meta.input) && meta.input.length > 0 ? { inputModalities: [...meta.input] } : {}),
      };
      out.push({
        ...model,
        ...(providers?.[provider] ? applyProviderConfigHints(provider, providers[provider], model, contextCap) : {}),
      });
    }
  }
  return out;
}
