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
  shouldLogDiscoveryFailure,
  setCached,
  type ProviderModelDiscoveryFailure,
} from "../model-cache";
import { buildModelsRequest, resolveModelsAuthToken } from "../../oauth";
import type { OcxConfig, OcxProviderConfig } from "../../types";
import { modelInList } from "../../types";
import { CODEX_REASONING_LEVELS, codexEffortRank, configuredReasoningEfforts, modelRecordValue, sanitizeCodexReasoningEfforts } from "../../reasoning-effort";
import { getJawcodeModelMetadata, getJawcodeModelMetadataCaseInsensitive, listJawcodeModelMetadata, resolveJawcodeProvider } from "../../generated/jawcode-model-metadata";
import { enrichProviderFromRegistry, shouldCaseFoldMetadataModelId } from "../../providers/derive";
import { getProviderRegistryEntry, providerMatchesRegistryTransport } from "../../providers/registry";
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
import {
  ProviderOutboundPolicyError,
  providerOutboundGet,
  providerRedirectError,
} from "../../lib/provider-outbound";
import { redactSecretString } from "../../lib/redact";
import {
  extractProviderModelItems,
  readBoundedDiscoveryJson,
  resolveProviderModelDiscovery,
  type ModelDiscoveryResponseFailure,
  type ProviderModelsApiItem,
} from "../../providers/model-discovery";
import upstreamModelsSnapshot from "../data/upstream-models.json";
import { createAdmissionGate, ResourceAdmissionError, type AdmissionMetrics } from "../../lib/admission";


import { JAWCODE_CATALOG_AUGMENT_PROVIDERS, catalogModelSlug, shouldExposeRoutedModel } from "./parsing";
import type { CatalogModel } from "./parsing";
import { disabledNativeSlugs, hasComboTargets, nativeInputModalities, nativeOpenAiContextWindow, nativeOpenAiSlugs, nativeParallelToolCalls, nativeReasoningEfforts } from "./metadata";
import { deriveComboCatalogModel, normalizedOpenAiApiSignature, openAiApiCollisionWarnings, replaceLastComboCatalogOmissions, warnUncataloguedComboOnce } from "./aggregation";
import type { ComboCatalogOmission } from "./aggregation";

/** Concurrent gatherRoutedModels callers with the same catalog identity share one live discovery.
 *  Keyed by gatherFlightKey so a different config cannot join or evict the wrong flight. */
interface GatherFlightResult {
  models: CatalogModel[];
  comboOmissions: ComboCatalogOmission[];
}

const gatherInflight = new Map<string, Promise<GatherFlightResult>>();
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

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return nested;
  });
}

function providerCatalogFingerprint(name: string, prov: OcxProviderConfig): Record<string, unknown> {
  return {
    n: name,
    // Preserve the persisted tri-state. Registry enrichment may turn an omitted value into
    // `false` while an explicit `true` stays live, so those callers must not share a flight.
    live: prov.liveModels ?? null,
    base: prov.baseUrl ?? "",
    adapter: prov.adapter ?? "",
    models: [...(prov.models ?? [])].sort(),
    selected: [...(prov.selectedModels ?? [])].sort(),
    defaultModel: prov.defaultModel ?? null,
    ctx: prov.contextWindow ?? null,
    ctxW: prov.modelContextWindows ?? null,
    maxIn: prov.modelMaxInputTokens ?? null,
    inMod: prov.modelInputModalities ?? null,
    re: prov.modelReasoningEfforts ?? null,
    defRe: prov.modelDefaultReasoningEfforts ?? null,
    rsSum: prov.modelSupportsReasoningSummaries ?? null,
    rsDel: prov.modelReasoningSummaryDelivery ?? null,
    noVis: [...(prov.noVisionModels ?? [])].sort(),
    ptc: prov.parallelToolCalls ?? null,
    gMode: prov.googleMode ?? null,
  };
}

function gatherFlightKey(config: OcxConfig): string {
  const providers = Object.entries(config.providers)
    .filter(([, prov]) => prov.disabled !== true)
    .map(([name, prov]) => providerCatalogFingerprint(name, prov))
    .sort((a, b) => String(a.n).localeCompare(String(b.n)));
  const assembly = stableJson({
    providers,
    disabledModels: [...(config.disabledModels ?? [])].sort(),
    combos: config.combos ?? {},
    customModels: (config.customModels ?? []).map((cm) => ({
      p: cm.provider,
      m: cm.modelId,
      d: cm.displayName ?? null,
      cw: cm.contextWindow ?? null,
      im: cm.inputModalities ?? null,
    })),
    caps: config.providerContextCaps ?? null,
  });
  const digest = createHash("sha256").update(assembly).digest("hex").slice(0, 16);
  return `${digest}#${config.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS}`;
}

/** Drop in-flight gather so tests / full cache clears do not reuse a stale promise. */
export function clearGatherRoutedModelsInflight(): void {
  gatherInflight.clear();
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

function configuredReasoningSummarySupport(prov: OcxProviderConfig | undefined, id: string): boolean | undefined {
  if (!prov) return undefined;
  const explicit = modelRecordValue(prov.modelSupportsReasoningSummaries, id);
  if (explicit !== undefined) return explicit;
  return modelRecordValue(prov.modelReasoningSummaryDelivery, id) !== undefined ? true : undefined;
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
  const supportsReasoningSummaries = configuredReasoningSummarySupport(prov, model.id);
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
let lastWarningReconciledGeneration = 0;

export function reconcileProviderFetchWarnings(generation: number): number {
  if (generation <= lastWarningReconciledGeneration) return 0;
  const removed = lastDropWarnSignature.size;
  lastDropWarnSignature.clear();
  lastWarningReconciledGeneration = generation;
  return removed;
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

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const MODEL_DISCOVERY_METADATA_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function positiveSafeInteger(...values: unknown[]): number | undefined {
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

function modelCapabilities(item: ProviderModelsApiItem): string[] | undefined {
  const metadata = plainRecord(item.metadata);
  const metadataCapabilities = metadata?.capabilities;
  const capabilityRecord = plainRecord(metadataCapabilities) ?? plainRecord(item.capabilities);
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

function modelInputModalities(
  item: ProviderModelsApiItem,
  capabilities: readonly string[] | undefined,
): string[] | undefined {
  const metadata = plainRecord(item.metadata);
  const capabilityRecord = plainRecord(metadata?.capabilities) ?? plainRecord(item.capabilities);
  const explicit = normalizedStringList(
    item.input_modalities
      ?? item.modalities
      ?? metadata?.input_modalities
      ?? capabilityRecord?.input_modalities,
    8,
    24,
  )?.filter(value => (
    // Codex parses `input_modalities` as a closed enum of text | image | audio. A provider that
    // advertises anything else (zenmux reports "video") must not reach the catalog: Codex rejects
    // the whole file, so plugins, apps and MCP servers all stop loading over one model's metadata.
    value === "text" || value === "image" || value === "audio"
  ));
  if (explicit && explicit.length > 0) return explicit;
  if (capabilityRecord?.vision === false) return ["text"];
  if (capabilityRecord?.vision === true || capabilities?.some(value => value === "vision" || value === "image-input")) {
    return ["text", "image"];
  }
  return undefined;
}

export function catalogHintsFromModelsApiItem(providerName: string, item: ProviderModelsApiItem): Partial<CatalogModel> {
  const metadata = plainRecord(item.metadata);
  const capabilityRecord = plainRecord(metadata?.capabilities) ?? plainRecord(item.capabilities);
  const limits = plainRecord(metadata?.limits);
  const contextWindow =
    positiveSafeInteger(
      limits?.max_context_length,
      metadata?.context_length,
      item.context_length,
      item.context_size,
      item.max_model_len,
      item.max_context_length,
    );
  const maxInputTokens = positiveSafeInteger(limits?.max_input_tokens, item.max_input_tokens);
  const rawReasoningEfforts = capabilityRecord?.reasoning_effort ?? item.reasoning_efforts;
  const listedReasoningEfforts = normalizedStringList(rawReasoningEfforts, 8, 24);
  const reasoningEfforts = listedReasoningEfforts
    ? sanitizeCodexReasoningEfforts(listedReasoningEfforts)
    : typeof rawReasoningEfforts === "boolean"
      ? (rawReasoningEfforts
        ? ((providerName === "neuralwatt" || providerName === "zai") && isGlm52ModelId(item.id)
          ? ["low", "medium", "high", "xhigh", "max"]
          : ["low", "medium", "high", "xhigh"])
        : [])
      : undefined;
  const capabilities = modelCapabilities(item);
  const inputModalities = modelInputModalities(item, capabilities);
  return {
    ...(contextWindow && contextWindow > 0 ? { contextWindow } : {}),
    ...(maxInputTokens && maxInputTokens > 0 ? { maxInputTokens } : {}),
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

function boundedOwnedBy(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return undefined;
  if (MODEL_DISCOVERY_METADATA_CONTROL_CHARS.test(value)) return undefined;
  return value;
}

export async function fetchProviderModels(name: string, prov: OcxProviderConfig, ttlMs: number, contextCap?: number): Promise<CatalogModel[]> {
  if (prov.authMode === "forward") return []; // ChatGPT backend has no /models
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
  // Static catalogs never need an OAuth refresh or an upstream model request. Clear any
  // discovery failure left by an older live configuration even when the account is logged out.
  if (prov.liveModels === false) {
    clearProviderDiscoveryStatus(name);
    return configured;
  }
  const apiKey = await resolveModelsAuthToken(name, prov);
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
      // Count what discovery actually returned, not the configured rows we fall back to.
      markProviderDiscoveryOk(name, liveResult.models.length);
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
  const fresh = getFreshCached(name, ttlMs);
  if (fresh) return withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, fresh, contextCap)); // dedups Codex's frequent /v1/models polling within the TTL
  if (isModelsFetchCoolingDown(name)) {
    // A recently-failed provider (unreachable API, missing proxy, bad key) must not re-pay the
    // fetch timeout on every catalog poll — the dashboard polls this path per page load.
    const stale = getStaleCached(name);
    return stale ? withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, stale, contextCap)) : failedDiscoveryConfigured;
  }
  const discovery = resolveProviderModelDiscovery(name, prov);
  const { url, headers } = buildModelsRequest(prov, apiKey, name);
  const urlClass = new URL(url).hostname.endsWith("aiplatform.googleapis.com")
    ? "vertex-aiplatform"
    : "provider-models";
  const failedDiscoveryFallback = (
    failure: ProviderModelDiscoveryFailure,
  ): { models: CatalogModel[]; fallback: "stale" | "configured"; shouldLog: boolean } => {
    // Decide logging BEFORE recording the new status, so we can compare against the prior one and
    // suppress an identical repeated failure (#395 log flood). The failure stays observable via the
    // discovery-status API regardless.
    const shouldLog = shouldLogDiscoveryFailure(name, failure);
    markModelsFetchFailure(name);
    markProviderDiscoveryFailed(name, failure);
    const stale = getStaleCached(name);
    return {
      models: stale
        ? withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, stale, contextCap))
        : failedDiscoveryConfigured,
      fallback: stale ? "stale" : "configured",
      shouldLog,
    };
  };
  try {
    const res = await providerOutboundGet(name, prov, url, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    const redirectError = await providerRedirectError(res, url);
    if (redirectError) {
      const { models, fallback, shouldLog } = failedDiscoveryFallback({ reason: "http", httpStatus: res.status });
      if (shouldLog) {
        console.warn(
          `[opencodex] Provider model discovery for "${name}" ${redirectError} [urlClass=${urlClass}, fallback=${fallback}].`,
        );
      }
      return models;
    }
    if (!res.ok) {
      const { models, fallback, shouldLog } = failedDiscoveryFallback({ reason: "http", httpStatus: res.status });
      if (shouldLog) {
        console.warn(
          `[opencodex] Provider model discovery for "${name}" failed with HTTP ${res.status} [urlClass=${urlClass}, fallback=${fallback}].`,
        );
      }
      return models;
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
      return models;
    }
    const extracted = extractProviderModelItems(bounded.value, discovery);
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
      return models;
    }
    const items = extracted.items;
    const live = items.map(m => {
      const ownedBy = boundedOwnedBy(m.owned_by);
      return applyProviderConfigHints(name, prov, {
        id: m.id,
        provider: name,
        ...(ownedBy ? { owned_by: ownedBy } : {}),
        ...catalogHintsFromModelsApiItem(name, m),
      }, contextCap);
    })
      .filter(m => shouldExposeProviderModel(name, m.id));
    // Capture the count BEFORE the alias/configured augmentation below pushes extra rows into
    // `live`; otherwise configured entries would be reported as discovered ones.
    const liveModelCount = live.length;
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
    markProviderDiscoveryOk(name, liveModelCount);
    setCached(name, live);
    return live;
  } catch (error) {
    if (error instanceof ProviderOutboundPolicyError) {
      const { models, fallback, shouldLog } = failedDiscoveryFallback({ reason: "blocked" });
      if (shouldLog) {
        console.warn(
          `[opencodex] Provider model discovery for "${name}" was blocked by destination policy: ${error.message} [urlClass=${urlClass}, fallback=${fallback}].`,
        );
      }
      return models;
    }
    const { models, fallback, shouldLog } = failedDiscoveryFallback({ reason: "network" });
    if (shouldLog) {
      console.warn(
        `[opencodex] Provider model discovery for "${name}" threw ${error instanceof Error ? error.name : "unknown"} [urlClass=${urlClass}, fallback=${fallback}].`,
      );
    }
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

export async function gatherRoutedModels(
  config: OcxConfig,
  options?: { comboOmissions?: ComboCatalogOmission[] },
): Promise<CatalogModel[]> {
  const key = gatherFlightKey(config);
  let promise = gatherInflight.get(key);
  if (!promise) {
    const lease = gatherGate.tryAcquire();
    if (!lease) throw new CatalogGatherBusyError();
    // Claim the slot synchronously before any await so same-key callers join this flight.
    // Distinct keys keep their own entries — a second config must not evict the first.
    const flight = gatherRoutedModelsUncached(config).finally(() => {
      if (gatherInflight.get(key) === flight) gatherInflight.delete(key);
      lease.release();
    });
    gatherInflight.set(key, flight);
    promise = flight;
  }
  const { models, comboOmissions } = await promise;
  if (options?.comboOmissions) {
    options.comboOmissions.length = 0;
    options.comboOmissions.push(...comboOmissions);
  }
  return models;
}

async function gatherRoutedModelsUncached(
  config: OcxConfig,
): Promise<GatherFlightResult> {
  // Flight-local list: joiners copy from the resolved promise, not a process-global last write.
  const localOmissions: ComboCatalogOmission[] = [];
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
    else warnUncataloguedComboOnce(id, combo, members, localOmissions);
  }
  replaceLastComboCatalogOmissions(localOmissions);
  all.sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)));
  // Enriched (registry-hydrated) provider clones, keyed by name — the same view used above so
  // custom rows get the same noVisionModels / inputModalities treatment as discovered rows.
  const enrichedByName = new Map(activeProviders);
  // Provider-derived rows keyed by their Codex-facing slug: a custom override replaces the row
  // with the same slug below, so that row's provider capability metadata is the inheritance source.
  const replacedByRoutedSlug = new Map(all.map(model => [routedSlug(model.provider, model.id), model]));
  const customModels = (config.customModels ?? []).map(cm => {
    const rawProvider = config.providers[cm.provider];
    const supportsReasoningSummaries = configuredReasoningSummarySupport(rawProvider, cm.modelId);
    const base: CatalogModel = {
      id: cm.modelId,
      provider: cm.provider,
      // Display-only label: never feeds routing (customModels are keyed by routedSlug below).
      ...(cm.displayName ? { displayName: cm.displayName } : {}),
      ...(cm.contextWindow ? { contextWindow: cm.contextWindow } : {}),
      ...(cm.inputModalities ? { inputModalities: cm.inputModalities } : {}),
      ...(typeof supportsReasoningSummaries === "boolean" ? { supportsReasoningSummaries } : {}),
    };
    // #962: the dedupe below drops the provider-derived row this custom row replaces. Inherit that
    // row's provider capability metadata (reasoning ladder, default effort, parallel tool calls,
    // context, ...) so the generated catalog keeps advertising what the router actually provides.
    // Explicit custom fields win by construction; this only fills gaps. Without it a
    // noReasoningModels model loses its empty ladder and the catalog synthesizes the generic one,
    // which Codex then rejects for spawn_agent with effort "none".
    const replaced = replacedByRoutedSlug.get(routedSlug(cm.provider, cm.modelId));
    const merged: CatalogModel = replaced ? {
      ...base,
      ...(base.contextWindow === undefined && replaced.contextWindow !== undefined ? { contextWindow: replaced.contextWindow } : {}),
      ...(base.maxInputTokens === undefined && replaced.maxInputTokens !== undefined ? { maxInputTokens: replaced.maxInputTokens } : {}),
      ...(base.inputModalities === undefined && replaced.inputModalities !== undefined ? { inputModalities: replaced.inputModalities } : {}),
      ...(base.reasoningEfforts === undefined && replaced.reasoningEfforts !== undefined ? { reasoningEfforts: replaced.reasoningEfforts } : {}),
      ...(base.defaultReasoningEffort === undefined && replaced.defaultReasoningEffort !== undefined ? { defaultReasoningEffort: replaced.defaultReasoningEffort } : {}),
      ...(base.parallelToolCalls === undefined && replaced.parallelToolCalls !== undefined ? { parallelToolCalls: replaced.parallelToolCalls } : {}),
      ...(base.supportsVerbosity === undefined && replaced.supportsVerbosity !== undefined ? { supportsVerbosity: replaced.supportsVerbosity } : {}),
      ...(base.supportsReasoningSummaries === undefined && replaced.supportsReasoningSummaries !== undefined ? { supportsReasoningSummaries: replaced.supportsReasoningSummaries } : {}),
      ...(base.capabilities === undefined && replaced.capabilities !== undefined ? { capabilities: replaced.capabilities } : {}),
    } : base;
    // Vision-sidecar coverage ONLY: if the custom model is in the enriched provider's
    // noVisionModels, advertise image input so the Codex app lets images reach the sidecar
    // (#349/#344). Deliberately NOT the full applyProviderConfigHints pass — custom rows are a
    // user override, so their explicit contextWindow / inputModalities / reasoning fields must be
    // preserved verbatim (the hint pass would cap context and overwrite modalities from registry).
    const enrichedProvider = enrichedByName.get(cm.provider) ?? rawProvider;
    if (enrichedProvider && modelInList(enrichedProvider.noVisionModels, merged.id)) {
      const current = merged.inputModalities ?? ["text"];
      if (!current.includes("image")) {
        return { ...merged, inputModalities: [...current, "image"] };
      }
    }
    return merged;
  });
  // Custom rows override discovered rows that encode to the same Codex-facing slug.
  const customKeys = new Set(customModels.map(c => routedSlug(c.provider, c.id)));
  const deduped = all.filter(m => !customKeys.has(routedSlug(m.provider, m.id)));
  return { models: [...deduped, ...customModels], comboOmissions: localOmissions };
}

export function augmentRoutedModelsWithRegistryOpenAiApiRows(
  models: CatalogModel[],
  config: OcxConfig,
): CatalogModel[] {
  const configured = config.providers[OPENAI_API_PROVIDER_ID];
  if (!configured || configured.disabled === true || !providerMatchesRegistryTransport(OPENAI_API_PROVIDER_ID, configured)) return models;
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
