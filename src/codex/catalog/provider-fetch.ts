import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { atomicWriteFile, expandUserPath, getConfigDir, resolveEnvValue, websocketsEnabled } from "../../config";
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
import { getModelMetadata, getModelMetadataCaseInsensitive, listModelMetadata, resolveMetadataProvider } from "../../generated/model-metadata";
import { enrichProviderFromRegistry, shouldCaseFoldMetadataModelId } from "../../providers/derive";
import {
  captureFastPolicyAuthority,
  fastPolicyForModel,
  serviceTierSupportFromPolicy,
} from "../../providers/service-tier";
import type { FastPolicyAuthority } from "../../providers/fastwire";
import { effectiveGoogleMode, getProviderRegistryEntry, providerMatchesRegistryTransport } from "../../providers/registry";
import { parseAntigravityAvailableModels, registerAntigravityDiscoveredWireModels } from "../../providers/antigravity-models";
import { applyProviderContextCap, providerContextCap, resolveUnknownRoutedContextWindow } from "../../providers/context-cap";
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
  providerOutboundPost,
  providerRedirectError,
} from "../../lib/provider-outbound";
import { redactSecretString } from "../../lib/redact";
import {
  extractProviderModelItems,
  readBoundedDiscoveryJson,
  resolveProviderModelDiscovery,
  type ModelDiscoveryResponseFailure,
  type ProviderModelsApiItem,
  type ResolvedProviderModelDiscovery,
} from "../../providers/model-discovery";
import upstreamModelsSnapshot from "../data/upstream-models.json";
import { createAdmissionGate, ResourceAdmissionError, type AdmissionMetrics } from "../../lib/admission";


import { CODEX_CUSTOM_MODEL_CATALOG_KIND, JAWCODE_CATALOG_AUGMENT_PROVIDERS, catalogModelSlug, shouldExposeRoutedModel } from "./parsing";
import type { CatalogModel } from "./parsing";
import { disabledNativeSlugs, hasComboTargets, isNativeOpenAiCapabilityAliasModel, NATIVE_GPT56_MAX_INPUT_TOKENS, nativeContextLimits, nativeDefaultReasoningEffort, nativeInputModalities, nativeOpenAiContextWindow, nativeOpenAiMaxInputTokens, nativeOpenAiSlugs, nativeParallelToolCalls, nativeReasoningEfforts } from "./metadata";
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

export type { CatalogGatherProviderAuthEvidence } from "./filesystem-evidence";

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

interface ProviderModelsResult {
  readonly models: CatalogModel[];
  readonly outcome: CatalogGatherProviderModelOutcome;
}

interface ModelsAuthResolution {
  readonly apiKey: string | undefined;
  readonly observed: boolean;
  readonly oauthApiBaseUrl?: string;
  readonly oauthProjectId?: string;
}

type ModelsAuthResolver =
  | { readonly kind: "refreshing" }
  | {
      readonly kind: "observed";
      readonly resolve: (name: string, provider: OcxProviderConfig) => ModelsAuthResolution;
    };

type ModelsAuthResolverFactory = (
  outcomes: CatalogGatherProviderAuthOutcome[],
) => ModelsAuthResolver;

interface CapturedModelsRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headersWithoutCredential: Readonly<Record<string, string>>;
  readonly headersWithCredential: Readonly<Record<string, string>>;
}

interface CapturedProviderGather {
  readonly name: string;
  readonly provider: OcxProviderConfig;
  readonly discovery: ResolvedProviderModelDiscovery;
  readonly policy: CatalogProviderDiscoveryPolicySnapshot;
  readonly request: CapturedModelsRequest;
  readonly fastPolicyAuthority: FastPolicyAuthority;
  readonly observedAuth?: ModelsAuthResolution;
  /**
   * Configured model ids this provider must keep even when live discovery omits
   * them — combo targets that are also listed in providers.*.models (OCX-111).
   * Combo-only ids (not in models[]) stay out of the public catalog and are
   * synthesized for combo derivation instead (#1305).
   */
  readonly retainConfiguredModelIds?: ReadonlySet<string>;
}

interface GatherFlightCapture {
  readonly discoveryPolicyIdentity: string;
  readonly authIdentity: string;
  readonly providerGraphIdentity: string;
  readonly discoveryPolicySnapshots: readonly CatalogProviderDiscoveryPolicySnapshot[];
  readonly providers: readonly CapturedProviderGather[];
  readonly authResolver: ModelsAuthResolver;
  readonly providerAuthOutcomes: readonly CatalogGatherProviderAuthOutcome[];
  readonly openAiApiPolicy: CatalogTrustedOpenAiApiPolicySnapshot;
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

function withCanonicalOpenAiForwardAuthDefault(
  name: string,
  provider: OcxProviderConfig,
): OcxProviderConfig {
  if (name !== OPENAI_CODEX_PROVIDER_ID || provider.authMode !== undefined) return provider;
  const candidate = { ...provider, authMode: "forward" as const };
  return isCanonicalOpenAiForwardProvider(candidate) ? candidate : provider;
}

const gatherInflight = new Map<string, GatherInflightEntry[]>();
const CATALOG_GATHER_AUTHORITY_KEY = randomBytes(32);
const REQUEST_CREDENTIAL_SENTINEL = `ocx-catalog-credential-${randomBytes(16).toString("hex")}`;
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

function keyedGatherBytesIdentity(domain: string, value: Uint8Array): string {
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

function captureTrustedOpenAiApiPolicy(
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

function captureProviderGather(
  name: string,
  configured: OcxProviderConfig,
  authResolver: ModelsAuthResolver,
  retainConfiguredModelIds?: ReadonlySet<string>,
): CapturedProviderGather {
  const enriched = detachedClone(withCanonicalOpenAiForwardAuthDefault(name, configured));
  enrichProviderFromRegistry(name, enriched);
  const registryTransportMatch = providerMatchesRegistryTransport(name, enriched);
  const provider = recursivelyFreeze(enriched);
  const fastPolicyAuthority = captureFastPolicyAuthority(
    name,
    provider,
    registryTransportMatch,
    configured,
  );
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
  return Object.freeze({
    name,
    provider,
    discovery,
    policy,
    request,
    fastPolicyAuthority,
    ...(observedAuth ? { observedAuth: Object.freeze({ ...observedAuth }) } : {}),
    ...(retainConfiguredModelIds && retainConfiguredModelIds.size > 0
      ? { retainConfiguredModelIds }
      : {}),
  });
}

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

function captureGatherFlight(
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

function materializeCapturedHeaders(
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
    serviceTier: prov.modelSupportsServiceTier ?? null,
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
  const fastPolicy = fastPolicyForModel(prov, model.id, name);
  const supportsServiceTier = serviceTierSupportFromPolicy(fastPolicy);
  const {
    supportsServiceTier: _staleServiceTier,
    fastTierDescription: _staleFastTierDescription,
    ...modelWithoutServiceTier
  } = model;
  // 已发现窗口只允许被配置值压低；缺窗口时，已开的 Context cap 就是实际窗口。
  const discoveredWindow = typeof model.contextWindow === "number" && model.contextWindow > 0
    ? model.contextWindow
    : undefined;
  const hintedWindow = discoveredWindow !== undefined
    ? (configuredCap !== undefined ? Math.min(discoveredWindow, configuredCap) : discoveredWindow)
    : (configuredCap ?? (providerCap !== undefined ? resolveUnknownRoutedContextWindow(providerCap) : undefined));
  const hinted = {
    ...modelWithoutServiceTier,
    ...(hintedWindow !== undefined ? { contextWindow: hintedWindow } : {}),
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
    ...(typeof supportsServiceTier === "boolean" ? { supportsServiceTier } : {}),
    ...(supportsServiceTier === true && fastPolicy.fastTierDescription !== undefined
      ? { fastTierDescription: fastPolicy.fastTierDescription }
      : {}),
    ...(prov.adapter === "kiro" ? { supportsVerbosity: false } : {}),
    // Default-on for openai-chat providers (explicit false opts out); other adapters
    // advertise only on explicit opt-in.
    ...(prov.parallelToolCalls === true || (prov.adapter === "openai-chat" && prov.parallelToolCalls !== false)
      ? { parallelToolCalls: true }
      : {}),
    ...(prov.codexToolMode !== undefined ? { codexToolMode: prov.codexToolMode } : {}),
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
  readonly inputModalities?: readonly string[];
  readonly reasoningEfforts?: readonly string[];
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
  fallback?: ComboCatalogMemberFallback,
): CatalogModel | undefined {
  const existing = memberByKey.get(targetKey(target));
  const prov = providers.get(target.provider);
  // Disabled providers never contribute members — even a complete discovery row
  // is unusable for catalog derivation while the provider is off.
  if (prov?.disabled === true) return undefined;

  const withFallbackMetadata = (member: CatalogModel): CatalogModel => {
    if (!fallback) return member;
    const contextWindow = typeof member.contextWindow === "number" && member.contextWindow > 0
      ? member.contextWindow
      : undefined;
    const addMaxInput = contextWindow !== undefined
      && !(typeof member.maxInputTokens === "number" && member.maxInputTokens > 0);
    const addModalities = (!Array.isArray(member.inputModalities) || member.inputModalities.length === 0)
      && fallback.inputModalities !== undefined;
    const addReasoning = member.reasoningEfforts === undefined
      && fallback.reasoningEfforts !== undefined;
    if (!addMaxInput && !addModalities && !addReasoning) return member;
    return {
      ...member,
      // Never claim a larger input budget than the window, and prefer the model's own
      // measured ceiling when the fallback carries one.
      ...(addMaxInput
        ? { maxInputTokens: Math.min(fallback.maxInputTokens ?? contextWindow!, contextWindow!) }
        : {}),
      ...(addModalities ? { inputModalities: [...fallback.inputModalities!] } : {}),
      ...(addReasoning ? { reasoningEfforts: [...fallback.reasoningEfforts!] } : {}),
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
    const capped = applyProviderContextCap(existing.contextWindow, contextCap);
    if (capped === undefined || capped === existing.contextWindow) {
      return withFallbackMetadata(existing);
    }
    const maxInput = typeof existing.maxInputTokens === "number" && existing.maxInputTokens > 0
      ? Math.min(existing.maxInputTokens, capped)
      : Math.min(fallback?.maxInputTokens ?? capped, capped);
    return withFallbackMetadata({
      ...existing,
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
    ? applyProviderConfigHints(target.provider, prov, base, contextCap)
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
  // The model's own measured input ceiling still applies when discovery gave us nothing:
  // GPT-5.6 advertises a 1.05M window but refuses input past 922k.
  const effectiveMaxInput = knownMaxInput ?? fallbackMaxInput;
  const maxInputTokens = effectiveMaxInput !== undefined
    ? Math.min(effectiveMaxInput, contextWindow)
    : contextWindow;

  return {
    ...hinted,
    inputModalities,
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
    contextWindow,
    maxInputTokens,
    ...(fallbackCapped ? { contextCap, contextCapped: true as const } : {}),
  };
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

function modelInputModalities(
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
  if (capabilityRecord?.vision === false) return ["text"];
  if (capabilityRecord?.vision === true || capabilities?.some(value => (
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
      // llama.cpp reports the served context under `meta`: `n_ctx` is what the
      // server was actually started with, `n_ctx_train` the model's trained
      // maximum. Prefer the served value — routing must not promise a window the
      // running server will refuse. Both come LAST so no provider already
      // supplying a recognized field changes behavior (#1797).
      plainRecord(item.meta)?.n_ctx,
      plainRecord(item.meta)?.n_ctx_train,
    );
  const maxInputTokens = positiveSafeInteger(limits?.max_input_tokens, item.max_input_tokens);
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

const refreshingModelsAuthResolver: ModelsAuthResolver = { kind: "refreshing" };

function observedModelsAuthResolver(
  authStoreBuffer: Uint8Array | null,
  outcomes: CatalogGatherProviderAuthOutcome[],
): ModelsAuthResolver {
  return {
    kind: "observed",
    resolve(name, provider) {
      if (provider.authMode === "forward") return { apiKey: undefined, observed: true };
      if (provider.authMode !== "oauth") {
        return { apiKey: resolveEnvValue(provider.apiKey), observed: true };
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

async function fetchProviderModelsWithAuth(
  captured: CapturedProviderGather,
  ttlMs: number,
  contextCap: number | undefined,
  resolveAuth: ModelsAuthResolver,
): Promise<ProviderModelsResult> {
  const { name, provider: prov, discovery, request } = captured;
  const observed = (
    models: CatalogModel[],
    state: CatalogGatherProviderModelOutcome["state"],
  ): ProviderModelsResult => ({ models, outcome: { provider: name, state } });
  // Capture before any credential refresh or outbound await. OAuth account changes clear this
  // generation, so a request started with the former account cannot later publish its result.
  const cacheGeneration = captureModelCacheGeneration(name);
  const isCurrentCacheGeneration = () => isModelCacheGenerationCurrent(name, cacheGeneration);
  if (prov.authMode === "forward") return observed([], "authoritative"); // ChatGPT backend has no /models
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
    if (!apiKey) return observed(configured, "degraded");
    // Cursor uses a bespoke GetUsableModels RPC (not /models), returning the full effort-suffixed
    // variants this PLAN can use. Keep the base-model UX (the request builder appends the effort
    // suffix) but filter the static seed to the bases the account actually has — so models not on the
    // plan (e.g. claude-fable-5) drop out instead of failing ERROR_BAD_MODEL_NAME. Fall back to the seed.
    const cachedCursor = getFreshCached(name, ttlMs);
    if (cachedCursor) {
      return observed(
        withConfiguredRetention(applyConfigHintsToCachedModels(name, prov, cachedCursor)),
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
        staleCursor ? applyConfigHintsToCachedModels(name, prov, staleCursor) : configured,
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
        withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, fresh, contextCap)),
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
          ? withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, stale, contextCap))
          : failedDiscoveryConfigured,
      ),
      "degraded",
    );
  }
  const url = request.url;
  const headers = materializeCapturedHeaders(request, apiKey);
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
          ? withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, stale, contextCap))
          : failedDiscoveryConfigured,
      ),
      fallback: stale ? "stale" : "configured",
      shouldLog,
    };
  };
  try {
    const res = request.method === "POST"
      ? await providerOutboundPost(name, prov, url, {
        headers,
        body: JSON.stringify({ project }),
        signal: AbortSignal.timeout(8000),
      })
      : await providerOutboundGet(name, prov, url, {
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
      }, contextCap));
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
      return observed(models, "degraded");
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

export function shouldExposeProviderModel(providerName: string, modelId: string): boolean {
  if (providerName === "opencode-free") return modelId === "big-pickle" || modelId.endsWith("-free");
  return true;
}

export function shouldRetainConfiguredProviderModel(providerName: string, modelId: string): boolean {
  if (CALLABLE_CONFIGURED_COMPATIBILITY_MODELS[providerName]?.has(modelId)) return true;
  if (providerName === "opencode-free") return modelId === "big-pickle" || modelId.endsWith("-free");
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
}): { models: CatalogModel[]; droppedConfiguredIds: string[] } {
  const {
    name,
    provider: prov,
    configured,
    retainConfiguredModelIds,
    contextCap,
    seedVertexDefault,
    retainComboTargets = true,
  } = opts;
  const out = [...opts.models];
  const present = new Set(out.map(model => model.id));
  const droppedConfiguredIds: string[] = [];
  for (const candidate of configured) {
    if (present.has(candidate.id)) continue;
    const dated = out.find(live => isDatedVariantId(live.id, candidate.id));
    if (dated) {
      out.push(applyProviderConfigHints(name, prov, { ...dated, id: candidate.id }, contextCap));
      present.add(candidate.id);
      continue;
    }
    if (
      seedVertexDefault === true
      || shouldRetainConfiguredProviderModel(name, candidate.id)
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
    if (Array.isArray(sel) && sel.length > 0) allowByProvider.set(name, new Set(sel));
  }
  return models.filter(m => {
    const nativeAlias = m.provider === COMBO_NAMESPACE && m.nativeAlias === true;
    // disabledModels may be stored raw (canonical) or encoded (legacy UI writes).
    for (const stored of disabled) {
      // Combo management stores the public alias, while canonical `combo/<id>` references
      // remain valid for backward compatibility through slugEquals below.
      if (m.alias !== undefined && stored === catalogModelSlug(m) && !nativeAlias) return false;
      if (slugEquals(stored, m.provider, m.id)) return false;
    }
    const allow = allowByProvider.get(m.provider);
    return !allow || allow.has(m.id);
  });
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
  const all = augmentRoutedModelsWithMetadata(apiAugmented, activeProviders.map(provider => provider.name), config.providers, config)
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
  // Enriched (registry-hydrated) provider clones — shared by combo member synthesis and
  // custom-model vision-sidecar inheritance so both see the same merged registry view.
  const enrichedByName = new Map(activeProviders.map(provider => [provider.name, provider.provider]));
  for (const id of listComboIds(config)) {
    const combo = getCombo(config, id);
    if (!combo) continue;
    const nativeContextWindow = combo.nativeAlias && combo.alias
      ? nativeOpenAiContextWindow(combo.alias, nativeContextLimits(config))
      : undefined;
    const nativeAliasMaxInput = combo.nativeAlias && combo.alias
      ? (combo.alias.startsWith("gpt-5.6-") || combo.alias.includes("daybreak")
        ? NATIVE_GPT56_MAX_INPUT_TOKENS
        : nativeOpenAiMaxInputTokens(combo.alias) ?? nativeOpenAiContextWindow(combo.alias))
      : undefined;
    const nativeAliasFallback = combo.nativeAlias && combo.alias && nativeContextWindow !== undefined
      ? {
        contextWindow: nativeContextWindow,
        ...(nativeAliasMaxInput !== undefined ? { maxInputTokens: nativeAliasMaxInput } : {}),
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
      && isNativeOpenAiCapabilityAliasModel(cm.modelId);
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
    const customMaxInputTokens = nativeAliasMaxInputTokens !== undefined && customContextWindow !== undefined
      ? Math.min(nativeAliasMaxInputTokens, customContextWindow)
      : nativeAliasMaxInputTokens;
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
        : codexForwardNativeCapabilityAlias ? { displayName: "Daybreak Blue" } : {}),
      ...(customContextWindow !== undefined ? { contextWindow: customContextWindow } : {}),
      ...(customMaxInputTokens !== undefined ? { maxInputTokens: customMaxInputTokens } : {}),
      ...(cm.inputModalities
        ? { inputModalities: cm.inputModalities }
        : codexForwardNativeCapabilityAlias ? { inputModalities: nativeInputModalities(cm.modelId) } : {}),
      ...(typeof supportsReasoningSummaries === "boolean" ? { supportsReasoningSummaries } : {}),
      // Native-alias defaults apply only where the custom row declares nothing: the explicit
      // spreads below must win (later in object order), so a stored `[]` stays empty and a
      // declared ladder is never replaced by the alias's native ladder.
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
      // verbatim instead of being replaced by the replaced row's metadata.
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
    const merged: CatalogModel = replaced ? {
      ...base,
      ...(base.contextWindow === undefined && replaced.contextWindow !== undefined ? { contextWindow: replaced.contextWindow } : {}),
      ...(base.maxInputTokens === undefined && replaced.maxInputTokens !== undefined ? { maxInputTokens: replaced.maxInputTokens } : {}),
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
  const providerModelOutcomes = providerResults.map(result => (
    result.outcome.provider === OPENAI_API_PROVIDER_ID
      && capture.openAiApiPolicy.state === "captured"
      && capture.openAiApiPolicy.models !== undefined
      ? { provider: result.outcome.provider, state: "authoritative" as const }
      : result.outcome
  ));
  return {
    models: [...deduped, ...customModels],
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
      ? Math.min(officialMaxInput, userMaxInput ?? officialMaxInput)
      : undefined;
    return {
      provider: OPENAI_API_PROVIDER_ID,
      id,
      owned_by: OPENAI_API_PROVIDER_ID,
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxInputTokens ? { maxInputTokens } : {}),
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
