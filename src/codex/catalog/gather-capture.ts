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
import { applyRegistryCapabilitySeedFill, modelCapabilities, modelInputModalities } from "./model-hints";
import { configuredComboTargetModelsByProvider } from "./combo-member";

/** Concurrent gatherRoutedModels callers with the same catalog identity share one live discovery.
 *  Keyed by gatherFlightKey so a different config cannot join or evict the wrong flight. */
export interface CatalogGatherProviderAuthOutcome {
  readonly provider: string;
  readonly state: OAuthActiveTokenObservation["kind"];
}

export interface CatalogGatherProviderModelOutcome {
  readonly provider: string;
  readonly state: "authoritative" | "degraded";
}
export interface ModelsAuthResolution {
  readonly apiKey: string | undefined;
  readonly observed: boolean;
  readonly oauthApiBaseUrl?: string;
  readonly oauthProjectId?: string;
}

export type ModelsAuthResolver =
  | { readonly kind: "refreshing" }
  | {
      readonly kind: "observed";
      readonly resolve: (name: string, provider: OcxProviderConfig) => ModelsAuthResolution;
    };

export type ModelsAuthResolverFactory = (
  outcomes: CatalogGatherProviderAuthOutcome[],
) => ModelsAuthResolver;

export interface CapturedModelsRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headersWithoutCredential: Readonly<Record<string, string>>;
  readonly headersWithCredential: Readonly<Record<string, string>>;
}

export interface CapturedProviderGather {
  readonly name: string;
  readonly provider: OcxProviderConfig;
  readonly discovery: ResolvedProviderModelDiscovery;
  readonly policy: CatalogProviderDiscoveryPolicySnapshot;
  readonly request: CapturedModelsRequest;
  readonly fastPolicyAuthority: FastPolicyAuthority;
  readonly metadataModelIdCaseFold: boolean;
  readonly effectiveAlias?: string | null;
  readonly observedAuth?: ModelsAuthResolution;
  /**
   * Configured model ids this provider must keep even when live discovery omits
   * them — combo targets that are also listed in providers.*.models (OCX-111).
   * Combo-only ids (not in models[]) stay out of the public catalog and are
   * synthesized for combo derivation instead (#1305).
   */
  readonly retainConfiguredModelIds?: ReadonlySet<string>;
}

export interface GatherFlightCapture {
  readonly discoveryPolicyIdentity: string;
  readonly authIdentity: string;
  readonly providerGraphIdentity: string;
  readonly discoveryPolicySnapshots: readonly CatalogProviderDiscoveryPolicySnapshot[];
  readonly providers: readonly CapturedProviderGather[];
  readonly authResolver: ModelsAuthResolver;
  readonly providerAuthOutcomes: readonly CatalogGatherProviderAuthOutcome[];
  readonly openAiApiPolicy: CatalogTrustedOpenAiApiPolicySnapshot;
}
export function withCanonicalOpenAiForwardAuthDefault(
  name: string,
  provider: OcxProviderConfig,
): OcxProviderConfig {
  if (name !== OPENAI_CODEX_PROVIDER_ID || provider.authMode !== undefined) return provider;
  const candidate = { ...provider, authMode: "forward" as const };
  return isCanonicalOpenAiForwardProvider(candidate) ? candidate : provider;
}
const CATALOG_GATHER_AUTHORITY_KEY = randomBytes(32);
const REQUEST_CREDENTIAL_SENTINEL = `ocx-catalog-credential-${randomBytes(16).toString("hex")}`;
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return nested;
  });
}

function framed(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function canonicalAuthorityEncoding(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `string${framed(value)}`;
  if (typeof value === "boolean") return value ? "boolean1" : "boolean0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Catalog authority cannot encode a non-finite number.");
    const encoded = Object.is(value, -0) ? "-0" : String(value);
    return `number${framed(encoded)}`;
  }
  if (Array.isArray(value)) {
    return `array${value.length}:${value.map(item => framed(canonicalAuthorityEncoding(item))).join("")}`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((left, right) => left.localeCompare(right));
    return `object${keys.length}:${keys.map(key => (
      `${framed(key)}${framed(canonicalAuthorityEncoding(record[key]))}`
    )).join("")}`;
  }
  throw new TypeError(`Catalog authority cannot encode ${typeof value}.`);
}

function keyedGatherIdentity(domain: string, value: unknown): string {
  return createHmac("sha256", CATALOG_GATHER_AUTHORITY_KEY)
    .update(framed(domain))
    .update(framed(canonicalAuthorityEncoding(value)))
    .digest("hex");
}

export function keyedGatherBytesIdentity(domain: string, value: Uint8Array): string {
  return createHmac("sha256", CATALOG_GATHER_AUTHORITY_KEY)
    .update(framed(domain))
    .update(`${value.byteLength}:`)
    .update(value)
    .digest("hex");
}

export function createCatalogGatherAuthorityIdentity(
  snapshot: CatalogAdmissionSnapshot,
  sourceEvidence: CatalogSourceEvidence,
  processLocal: CatalogProcessLocalEvidence,
  discoveryPolicies: readonly CatalogProviderDiscoveryPolicySnapshot[],
): CatalogGatherAuthorityIdentity {
  const sourceEvidenceIdentity = keyedGatherIdentity("catalog-source-evidence-v1", sourceEvidence);
  const processLocalEvidenceIdentity = keyedGatherIdentity("catalog-process-local-v1", processLocal);
  const discoveryPolicyIdentity = keyedGatherIdentity("catalog-discovery-policy-v1", discoveryPolicies);
  return Object.freeze({
    version: 1 as const,
    authorityId: keyedGatherIdentity("catalog-authority-v1", {
      admittedConfig: snapshot.configIdentity,
      discoveryPolicyIdentity,
      sourceEvidenceIdentity,
      processLocalEvidenceIdentity,
    }),
    admittedConfig: Object.freeze({
      ...snapshot.configIdentity,
      generation: Object.freeze({ ...snapshot.configIdentity.generation }),
    }),
    authSnapshotIdentity: keyedGatherIdentity(
      "catalog-auth-v1",
      sourceEvidence.conditional["provider-auth-selection"],
    ),
    discoveryPolicyIdentity,
    nativeCatalogSourceIdentity: keyedGatherIdentity(
      "catalog-native-v1",
      sourceEvidence.conditional["native-catalog-selection"],
    ),
    sourceEvidenceIdentity,
    processLocalEvidenceIdentity,
  });
}

function detachedClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => detachedClone(item)) as T;
  if (value && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      clone[key] = detachedClone((value as Record<string, unknown>)[key]);
    }
    return clone as T;
  }
  return value;
}

function recursivelyFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) recursivelyFreeze(nested);
  return Object.freeze(value);
}

function detachedFrozen<T>(value: T): T {
  return recursivelyFreeze(detachedClone(value));
}

function capturedField<T extends object, K extends keyof T>(
  value: T | undefined,
  key: K,
): CatalogDiscoveryPolicyField<T[K]> {
  if (!value || !Object.hasOwn(value, key)) return Object.freeze({ state: "absent" });
  return detachedFrozen({ state: "present" as const, value: value[key] });
}

export function captureTrustedOpenAiApiPolicy(
  name: string,
  registryTransportMatch: boolean,
): CatalogTrustedOpenAiApiPolicySnapshot {
  if (name !== OPENAI_API_PROVIDER_ID) return Object.freeze({ state: "unused" });
  if (!registryTransportMatch) return Object.freeze({ state: "transport-mismatch" });
  const entry = getProviderRegistryEntry(name);
  if (!entry?.models) return Object.freeze({ state: "registry-models-absent" });
  return detachedFrozen({
    state: "captured" as const,
    models: entry.models,
    ...(entry.modelContextWindows ? { modelContextWindows: entry.modelContextWindows } : {}),
    ...(entry.modelMaxInputTokens ? { modelMaxInputTokens: entry.modelMaxInputTokens } : {}),
    ...(entry.modelMaxOutputTokens ? { modelMaxOutputTokens: entry.modelMaxOutputTokens } : {}),
    ...(entry.virtualModels ? { virtualModels: entry.virtualModels } : {}),
    ...(entry.modelInputModalities ? { modelInputModalities: entry.modelInputModalities } : {}),
    ...(entry.modelReasoningEfforts ? { modelReasoningEfforts: entry.modelReasoningEfforts } : {}),
  });
}

function captureModelsRequest(
  name: string,
  provider: OcxProviderConfig,
  observedAuth: ModelsAuthResolution | undefined,
): CapturedModelsRequest {
  const observed = observedAuth
    ? { oauthApiBaseUrl: observedAuth.oauthApiBaseUrl }
    : undefined;
  const withoutCredential = buildModelsRequest(provider, undefined, name, observed);
  const withCredential = buildModelsRequest(provider, REQUEST_CREDENTIAL_SENTINEL, name, observed);
  const method = withoutCredential.method ?? "GET";
  if (withoutCredential.url !== withCredential.url || method !== (withCredential.method ?? "GET")) {
    throw new TypeError(`Provider model discovery URL for ${name} depends on credential bytes.`);
  }
  return detachedFrozen({
    method,
    url: withoutCredential.url,
    headersWithoutCredential: withoutCredential.headers,
    headersWithCredential: withCredential.headers,
  });
}
export function captureProviderGather(
  name: string,
  configured: OcxProviderConfig,
  authResolver: ModelsAuthResolver,
  retainConfiguredModelIds?: ReadonlySet<string>,
  config?: Pick<OcxConfig, "providers">,
): CapturedProviderGather {
  const enriched = detachedClone(withCanonicalOpenAiForwardAuthDefault(name, configured));
  enrichProviderFromRegistry(name, enriched);
  applyRegistryCapabilitySeedFill(name, enriched);
  const registryTransportMatch = providerMatchesRegistryTransport(name, enriched);
  const provider = recursivelyFreeze(enriched);
  const fastPolicyAuthority = captureFastPolicyAuthority(
    name,
    provider,
    registryTransportMatch,
    configured,
  );
  const metadataModelIdCaseFold = shouldCaseFoldMetadataModelId(name);
  const observedAuth = authResolver.kind === "observed"
    && provider.authMode !== "forward"
    && provider.liveModels !== false
    ? authResolver.resolve(name, provider)
    : undefined;
  const request = captureModelsRequest(name, provider, observedAuth);
  const resolved = resolveProviderModelDiscovery(name, provider);
  const discovery = detachedFrozen({
    ...(resolved.spec ? { spec: resolved.spec } : {}),
    maxResponseBytes: resolved.maxResponseBytes,
    maxModels: resolved.maxModels,
  });
  const trustedOpenAiApi = captureTrustedOpenAiApiPolicy(name, registryTransportMatch);
  const policy = detachedFrozen({
    provider: name,
    registryTransportMatch,
    location: {
      spec: discovery.spec ? "present" as const : "absent" as const,
      url: capturedField(discovery.spec, "url"),
      path: capturedField(discovery.spec, "path"),
      query: capturedField(discovery.spec, "query"),
    },
    finalMethod: request.method,
    finalUrl: request.url,
    filter: capturedField(discovery.spec, "filter"),
    maxResponseBytes: discovery.maxResponseBytes,
    maxModels: discovery.maxModels,
    trustedOpenAiApi,
  });
  const effectiveAlias = effectiveProviderAliasDecision(name, configured, config);
  return Object.freeze({
    name,
    provider,
    discovery,
    policy,
    request,
    fastPolicyAuthority,
    metadataModelIdCaseFold,
    effectiveAlias,
    ...(observedAuth ? { observedAuth: Object.freeze({ ...observedAuth }) } : {}),
    ...(retainConfiguredModelIds && retainConfiguredModelIds.size > 0
      ? { retainConfiguredModelIds }
      : {}),
  });
}
export function captureGatherFlight(
  config: OcxConfig,
  createAuthResolver: ModelsAuthResolverFactory,
): GatherFlightCapture {
  const providerAuthOutcomes: CatalogGatherProviderAuthOutcome[] = [];
  const authResolver = createAuthResolver(providerAuthOutcomes);
  const comboTargetsByProvider = configuredComboTargetModelsByProvider(config);
  const providers = Object.entries(config.providers)
    .filter(([, provider]) => provider.disabled !== true)
    .map(([name, provider]) => captureProviderGather(
      name,
      provider,
      authResolver,
      comboTargetsByProvider.get(name),
      config,
    ));
  const discoveryPolicySnapshots = Object.freeze(providers.map(provider => provider.policy));
  return Object.freeze({
    discoveryPolicyIdentity: keyedGatherIdentity("catalog-discovery-policy-v1", discoveryPolicySnapshots),
    // Credentials are hashed under the same unexported per-process key, never
    // stored or compared in the clear: this value can reach a map key and must
    // not disclose a token. The final headers are included because a static
    // header can carry authority just as an `apiKey` can.
    authIdentity: keyedGatherIdentity("catalog-gather-auth-v1", providers.map(provider => ({
      name: provider.name,
      authMode: provider.provider.authMode ?? null,
      liveModels: provider.provider.liveModels ?? null,
      credential: provider.provider.apiKey ?? null,
      observedAuth: provider.observedAuth ?? null,
      headers: provider.request.headersWithCredential,
      url: provider.request.url,
    }))),
    // Every enriched provider row the flight will gather from, in admission order.
    // Anything that can change a catalog row lives in here by construction.
    providerGraphIdentity: keyedGatherIdentity("catalog-gather-provider-graph-v1",
      providers.map(provider => ({
        name: provider.name,
        // `fetch` is a caller-owned transport executor, not admitted state: the
        // outbound transport honors it so a caller can supply its own HTTP path.
        // It is the one member of a provider row that is legitimately a function,
        // so it is dropped here rather than allowed to break every encode.
        provider: omitProviderTransportExecutor(provider.provider),
        fastPolicyAuthority: provider.fastPolicyAuthority,
        // Combo retention is capture-time state, not a provider-row field. Two
        // gathers that share providers but differ in combo targets must not join.
        retainConfiguredModelIds: [...(provider.retainConfiguredModelIds ?? [])].sort(),
      }))),
    discoveryPolicySnapshots,
    providers: Object.freeze(providers),
    authResolver,
    providerAuthOutcomes: Object.freeze([...providerAuthOutcomes]),
    openAiApiPolicy: providers.find(provider => provider.name === OPENAI_API_PROVIDER_ID)?.policy.trustedOpenAiApi
      ?? Object.freeze({ state: "unused" as const }),
  });
}

/**
 * Drop the caller-owned transport executor before hashing a provider row.
 *
 * Fails closed on anything ELSE that cannot be encoded: the point of hashing the
 * whole row is that no field escapes the comparison, so a second function member
 * must surface as an encode error rather than being quietly skipped here.
 */
function omitProviderTransportExecutor(provider: OcxProviderConfig): Record<string, unknown> {
  const entries = Object.entries(provider).filter(([key]) => key !== "fetch");
  return Object.fromEntries(entries);
}

export function materializeCapturedHeaders(
  request: CapturedModelsRequest,
  apiKey: string | undefined,
): Record<string, string> {
  const source = apiKey ? request.headersWithCredential : request.headersWithoutCredential;
  return Object.fromEntries(Object.entries(source).map(([name, value]) => [
    name,
    apiKey ? value.split(REQUEST_CREDENTIAL_SENTINEL).join(apiKey) : value,
  ]));
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
    retain: [...(prov.retainModels ?? [])].sort(),
    selected: [...(prov.selectedModels ?? [])].sort(),
    displayNames: prov.modelDisplayNames ?? null,
    defaultModel: prov.defaultModel ?? null,
    ctx: prov.contextWindow ?? null,
    ctxW: prov.modelContextWindows ?? null,
    maxIn: prov.modelMaxInputTokens ?? null,
    maxOut: prov.modelMaxOutputTokens ?? null,
    autoCompact: prov.modelAutoCompactTokenLimits ?? null,
    inMod: prov.modelInputModalities ?? null,
    capabilities: prov.modelCapabilities ?? null,
    re: prov.modelReasoningEfforts ?? null,
    defRe: prov.modelDefaultReasoningEfforts ?? null,
    rsSum: prov.modelSupportsReasoningSummaries ?? null,
    verbosity: prov.modelSupportsVerbosity ?? null,
    rsDel: prov.modelReasoningSummaryDelivery ?? null,
    serviceTier: prov.modelSupportsServiceTier ?? null,
    noVis: [...(prov.noVisionModels ?? [])].sort(),
    ptc: prov.parallelToolCalls ?? null,
    gMode: prov.googleMode ?? null,
  };
}

export function gatherFlightKey(config: OcxConfig): string {
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
