import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { CatalogModel } from "../../codex/catalog";
import { catalogModelSlug, invalidateCodexModelsCache, nativeModelRows, uniqueCatalogModelsForPublicList } from "../../codex/catalog";
import { clearGatherRoutedModelsInflight } from "../../codex/catalog/provider-fetch";
import {
  DEFAULT_SUBAGENT_MODELS,
  adoptPersistedProviderIntoLiveConfig,
  codexAutoStartEnabled,
  hasOwnProvider,
  isValidProviderName,
  modelDisplayNamesConfigError,
  multiAgentGuidanceEnabled,
  mutatePersistedConfig,
  nonBlankStringArrayConfigError,
  normalizeNonBlankStringArray,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  requestPacingConfigError,
  readConfigAdmissionSnapshot,
  saveConfigPreservingClaudeCode,
  upstreamHttpVersionConfigError,
  validateConfigCandidate,
  withConfigMutationLockSync,
} from "../../config";
import {
  clearLoginState,
  getLoginStatus,
  isPublicOAuthProvider,
  listOAuthProviders,
  startLoginFlow,
  submitManualLoginCode,
  upsertOAuthProvider,
} from "../../oauth";
import { replaceProviderAccountSet } from "../../oauth/store";
import { providerDestinationResolvedError } from "../../lib/destination-policy";
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import { ProviderOutboundPolicyError, providerOutboundGet, providerOutboundPost, providerRedirectError } from "../../lib/provider-outbound";
import { fetchCursorUsableModels } from "../../adapters/cursor/live-models";
import { parseAntigravityAvailableModels } from "../../providers/antigravity-models";
import { enrichProviderFromCatalog, listKeyLoginProviders } from "../../oauth/key-providers";
import { deriveProviderPresets, providerConfigSeed } from "../../providers/derive";
import { effectiveGoogleMode, providerCodexAccountMode, providerMatchesRegistryTransport } from "../../providers/registry";
import {
  extractModelEnvelopeRows,
  extractProviderModelItems,
  readBoundedDiscoveryJson,
  resolveProviderModelDiscovery,
} from "../../providers/model-discovery";
import { routedSlug, slugEquals } from "../../providers/slug-codec";
import { clearAccountQuotaCache, clearProviderQuotaCache, fetchProviderQuotaReports } from "../../providers/quota";
import { clearKeyCooldowns } from "../../providers/key-failover";
import { providerRequestPacingStatus } from "../../providers/request-pacing";
import { CODEX_FORWARD_BASE_URL, isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { codexAccountNamespaceProviderCollisionError } from "../../codex/account-namespace-match";
import { clearThreadAccountMap } from "../../codex/routing";
import { primeCodexPoolQuotas } from "../../codex/auth-api";
import { clearModelCache, getProviderDiscoveryStatus } from "../../codex/model-cache";
import { getCodexModelEntitlementStatus } from "../../codex/model-entitlements";
import { DEFAULT_PROVIDER_CONTEXT_CAP, globalContextCapValue, providerContextCap, providerContextCaps, setAllProviderContextCaps, setGlobalContextCapValue, setProviderContextCap } from "../../providers/context-cap";
import { modelAutoCompactTokenLimitsConfigError } from "../../providers/auto-compact-budget";
import { resolveCodexHomeDir } from "../../codex/home";
import { readUsageEntries } from "../../usage/log";
import { getUsageDebugLogEntries } from "../../usage/debug";
import { parseRange, parseUsageSurface, summarizeUsage } from "../../usage/summary";
import { stripCodexRuntimeProviderFields } from "../../codex/auth-context";
import { getProviderRegistryEntry } from "../../providers/registry";
import { getDebugLogEntries } from "../../lib/debug-log-buffer";
import { getInjectionDebugLogEntries } from "../../lib/injection-debug-log";
import {
  clearDebugSettings,
  clearDebugSetting,
  getDebugSettings,
  setDebugSettings,
  type DebugFlag,
} from "../../lib/debug-settings";
import type { OcxClaudeCodeConfig, OcxConfig, OcxCustomModel, OcxProviderConfig } from "../../types";
import { drainAndShutdown } from "../lifecycle";
import { filterRequestLogs, getRequestLogEntries, type RequestLogEntry } from "../request-log";
import { estimateComboCost, estimateRequestCost, normalizeCostTokens, tokensPerSecond } from "../../usage/cost";
import type { PersistedUsageAttempt } from "../../usage/log";
import {
  isAllowedRequestOrigin,
  jsonResponse,
  parseProviderEditorConfigDTO,
  providerEditorConfigDTO,
  providerManagementConfigError,
  publicProviderBaseUrl,
  safeConfigDTO,
  type ProviderEditorConfigDTO,
  type ProviderEditorProviderDTO,
} from "../auth-cors";
import { providerServiceTierConfigError } from "./provider-capability-config";
import { providerEmptyToolOutputConfigError } from "../../config/provider-validation";
import { applySystemEnvToggle } from "../system-env";
import {
  LOCAL_PROVIDER_RELOAD_NAME_HEADER,
  LOCAL_PROVIDER_RELOAD_PATH,
} from "../../lib/local-provider-reload-contract";
import { refreshUserCostOverlays } from "../../usage/user-cost-overlays";
import { redactSecretString } from "../../lib/redact";
import {
  XAI_RESPONSES_OPT_IN_MODELS,
  xaiResponsesOptInState,
} from "../../providers/xai-responses-opt-in";
import { dropProviderCustomModels } from "../../providers/provider-id-rewrite";

import { isPlainRecord, parseDebugLogQuery, tokPerSecondResult, unavailableCostReason, costResult, requestLogDto, stripRegistryOnlyStaticHeaders, fetchAllModels } from "./shared";
import type { MetricUnavailableReason, TokPerSecondResult, CostEstimateReason, CostResult, MetricSource } from "./shared";
import type { ManagementContext } from "./context";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";

type ProviderPatchApplication =
  | { error: string }
  | {
      next: OcxProviderConfig;
      touched: boolean;
      editorTouched: boolean;
      enablingOpenAi: boolean;
      headersTouched: boolean;
    };

const PROVIDER_ALIAS_OVERLAY_FIELDS = ["alias", "modelAliases", "defaultAliases"] as const;
type ProviderAliasOverlayField = typeof PROVIDER_ALIAS_OVERLAY_FIELDS[number];

/**
 * Alias overlays are owned by the dedicated alias management routes. A full provider POST
 * may round-trip an already-persisted value, but it must not create, clear, or change one.
 * PATCH is field-masked and rejects these keys outright below.
 */
function providerAliasOverlayOwnershipError(
  submitted: Record<string, unknown>,
  existing: OcxProviderConfig | undefined,
): string | null {
  for (const field of PROVIDER_ALIAS_OVERLAY_FIELDS) {
    if (!Object.hasOwn(submitted, field)) continue;
    if (!existing || !Object.hasOwn(existing, field)) {
      return `${field} is managed by the dedicated alias API`;
    }
    const incoming = submitted[field];
    const persisted = existing[field];
    if (field === "modelAliases") {
      if (!isPlainRecord(incoming) || !isPlainRecord(persisted)) {
        return "modelAliases is managed by the dedicated alias API";
      }
      const incomingEntries = Object.entries(incoming);
      const persistedEntries = Object.entries(persisted);
      if (
        incomingEntries.length !== persistedEntries.length
        || incomingEntries.some(([model, alias]) => typeof alias !== "string" || persisted[model] !== alias)
      ) {
        return "modelAliases is managed by the dedicated alias API";
      }
      continue;
    }
    if (incoming !== persisted) return `${field} is managed by the dedicated alias API`;
  }
  return null;
}

/** Remove only alias overlays whose ownership has already been established by the caller. */
function providerTransportValidationCandidate(provider: Record<string, unknown>): Record<string, unknown> {
  const candidate = { ...provider };
  for (const field of PROVIDER_ALIAS_OVERLAY_FIELDS) delete candidate[field];
  return candidate;
}

/** Preserve the authoritative alias values from the stored provider during a full edit. */
function restorePersistedAliasOverlays(target: OcxProviderConfig, existing: OcxProviderConfig | undefined): void {
  for (const field of PROVIDER_ALIAS_OVERLAY_FIELDS) {
    delete (target as Record<ProviderAliasOverlayField, unknown>)[field];
    if (!existing || !Object.hasOwn(existing, field)) continue;
    const value = existing[field];
    (target as Record<ProviderAliasOverlayField, unknown>)[field] = field === "modelAliases"
      ? structuredClone(value)
      : value;
  }
}

type ProviderEditorCandidateResult =
  | { ok: true; config: OcxConfig; removedProviders: string[] }
  | { ok: false; status: 400 | 409; error: string; code: string };

type ProviderEditorMutationValue = ProviderEditorCandidateResult;

function mergeProviderEditorRow(
  persisted: OcxProviderConfig | undefined,
  baseline: ProviderEditorProviderDTO | undefined,
  next: ProviderEditorProviderDTO,
): OcxProviderConfig {
  const merged = structuredClone(persisted ?? {}) as Record<string, unknown>;
  const fields = new Set([...Object.keys(baseline ?? {}), ...Object.keys(next)]);
  for (const field of fields) {
    const baselineHasField = baseline !== undefined && Object.hasOwn(baseline, field);
    const nextHasField = Object.hasOwn(next, field);
    if (
      baselineHasField === nextHasField
      && (!baselineHasField || isDeepStrictEqual(baseline[field], next[field]))
    ) {
      continue;
    }
    if (nextHasField) merged[field] = structuredClone(next[field]);
    else delete merged[field];
  }
  return merged as unknown as OcxProviderConfig;
}

/** Build and validate a complete candidate without mutating the caller's snapshot. */
function providerEditorCandidate(
  persisted: OcxConfig,
  baseline: ProviderEditorConfigDTO,
  next: ProviderEditorConfigDTO,
): ProviderEditorCandidateResult {
  const candidate = structuredClone(persisted);
  const removedProviders = Object.keys(persisted.providers)
    .filter(name => !Object.hasOwn(next.providers, name));

  for (const name of removedProviders) {
    const dependentCombos = Object.entries(persisted.combos ?? {})
      .filter(([, combo]) => combo.targets.some(target => target.provider === name))
      .map(([id]) => id)
      .sort((a, b) => a.localeCompare(b));
    if (dependentCombos.length > 0) {
      return {
        ok: false,
        status: 409,
        error: `cannot delete provider ${JSON.stringify(redactSecretString(name))} while combos depend on it`,
        code: "provider_has_dependent_combos",
      };
    }
  }

  const providers: Record<string, OcxProviderConfig> = Object.create(null);
  for (const [name, publicProvider] of Object.entries(next.providers)) {
    if (!isValidProviderName(name)) {
      return {
        ok: false,
        status: 400,
        error: "provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key",
        code: "invalid_provider_name",
      };
    }
    const namespaceCollision = codexAccountNamespaceProviderCollisionError(candidate.codexAccountNamespaces, name);
    if (namespaceCollision) return { ok: false, status: 409, error: namespaceCollision, code: "provider_namespace_conflict" };
    const merged = mergeProviderEditorRow(persisted.providers[name], baseline.providers[name], publicProvider);
    const transportCandidate = providerTransportValidationCandidate(merged as unknown as Record<string, unknown>);
    const providerError = providerManagementConfigError(name, transportCandidate)
      ?? providerEmptyToolOutputConfigError(name, transportCandidate)
      ?? providerServiceTierConfigError(name, transportCandidate);
    if (providerError) return { ok: false, status: 400, error: providerError, code: "invalid_provider" };
    providers[name] = merged;
  }

  const defaultProvider = next.defaultProvider.trim();
  const selectedDefault = providers[defaultProvider];
  if (!selectedDefault) {
    return { ok: false, status: 400, error: "defaultProvider must name a configured provider", code: "invalid_default_provider" };
  }
  if (selectedDefault.disabled === true) {
    return { ok: false, status: 400, error: "defaultProvider cannot be disabled", code: "default_provider_disabled" };
  }

  candidate.defaultProvider = defaultProvider;
  candidate.providers = providers;
  for (const name of removedProviders) {
    dropProviderCustomModels(candidate, name);
    setProviderContextCap(candidate, name, false);
  }
  const validated = validateConfigCandidate(candidate);
  if (!validated.ok) {
    return { ok: false, status: 400, error: validated.error, code: "invalid_provider_editor_config" };
  }
  return { ok: true, config: candidate, removedProviders };
}

function adoptProviderEditorCandidate(live: OcxConfig, persisted: OcxConfig): void {
  live.defaultProvider = persisted.defaultProvider;
  for (const name of Object.keys(live.providers)) {
    if (!Object.hasOwn(persisted.providers, name)) delete live.providers[name];
  }
  for (const [name, provider] of Object.entries(persisted.providers)) {
    live.providers[name] = structuredClone(provider);
  }
  if (persisted.customModels === undefined) delete live.customModels;
  else live.customModels = structuredClone(persisted.customModels);
  if (persisted.providerContextCaps === undefined) delete live.providerContextCaps;
  else live.providerContextCaps = structuredClone(persisted.providerContextCaps);
}

/**
 * Apply the recognized PATCH field mask onto a provider copy. The caller runs this once
 * for validation and again inside the config mutation lock against the newest provider,
 * so a concurrent PATCH cannot be erased by a save of a stale snapshot. Only synchronous
 * checks live here; the async destination probe stays in the route.
 */
function applyProviderPatchFields(
  name: string,
  provider: OcxProviderConfig,
  rawBody: Record<string, unknown>,
  keys: string[],
  config: OcxConfig,
): ProviderPatchApplication {
  const next: OcxProviderConfig = { ...provider };
  let touched = false;
  let headersTouched = false;

  if (Object.hasOwn(rawBody, "disabled")) {
    if (typeof rawBody.disabled !== "boolean") return { error: "disabled must be a boolean" };
    if (rawBody.disabled && name === config.defaultProvider) {
      return { error: "cannot disable the default provider; set another default first" };
    }
    next.disabled = rawBody.disabled;
    touched = true;
  }
  if (Object.hasOwn(rawBody, "adapter")) {
    if (typeof rawBody.adapter !== "string" || !rawBody.adapter.trim()) return { error: "adapter must be a non-empty string" };
    next.adapter = rawBody.adapter.trim();
    touched = true;
  }
  if (Object.hasOwn(rawBody, "baseUrl")) {
    if (typeof rawBody.baseUrl !== "string" || !rawBody.baseUrl.trim()) return { error: "baseUrl must be a non-empty string" };
    next.baseUrl = rawBody.baseUrl.trim();
    touched = true;
  }
  if (Object.hasOwn(rawBody, "defaultModel")) {
    if (typeof rawBody.defaultModel !== "string") return { error: "defaultModel must be a string" };
    const dm = rawBody.defaultModel.trim();
    if (dm) next.defaultModel = dm;
    else delete next.defaultModel;
    touched = true;
  }
  if (Object.hasOwn(rawBody, "authMode")) {
    if (typeof rawBody.authMode !== "string") return { error: "authMode must be a string" };
    const mode = rawBody.authMode.trim();
    if (mode === "key" || mode === "forward" || mode === "oauth" || mode === "local") {
      next.authMode = mode;
      touched = true;
    } else if (mode === "") {
      delete next.authMode;
      touched = true;
    } else {
      return { error: "authMode must be key, forward, oauth, or local" };
    }
  }
  if (Object.hasOwn(rawBody, "apiKeyTransport")) {
    const transport = rawBody.apiKeyTransport;
    if (transport === "x-api-key" || transport === "bearer") {
      next.apiKeyTransport = transport;
      touched = true;
    } else if (transport === "") {
      delete next.apiKeyTransport;
      touched = true;
    } else {
      return { error: "apiKeyTransport must be x-api-key, bearer, or empty to clear" };
    }
  }
  if (Object.hasOwn(rawBody, "note")) {
    if (typeof rawBody.note !== "string") return { error: "note must be a string" };
    const note = rawBody.note.trim();
    if (note) next.note = note;
    else delete next.note;
    touched = true;
  }
  if (Object.hasOwn(rawBody, "allowPrivateNetwork")) {
    if (typeof rawBody.allowPrivateNetwork !== "boolean") return { error: "allowPrivateNetwork must be a boolean" };
    next.allowPrivateNetwork = rawBody.allowPrivateNetwork;
    touched = true;
  }
  if (Object.hasOwn(rawBody, "liveModels")) {
    if (typeof rawBody.liveModels !== "boolean") return { error: "liveModels must be a boolean" };
    next.liveModels = rawBody.liveModels;
    touched = true;
  }
  if (Object.hasOwn(rawBody, "annotateEmptyToolOutputs")) {
    const value = rawBody.annotateEmptyToolOutputs;
    if (value === null) {
      delete next.annotateEmptyToolOutputs;
    } else if (typeof value === "boolean") {
      next.annotateEmptyToolOutputs = value;
    } else {
      return { error: "annotateEmptyToolOutputs must be a boolean or null" };
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "xaiResponsesOptIn")) {
    if (name !== "xai") return { error: "xaiResponsesOptIn is valid only for provider xai" };
    if (typeof rawBody.xaiResponsesOptIn !== "boolean") {
      return { error: "xaiResponsesOptIn must be a boolean" };
    }
    const modelAdapters = { ...(next.modelAdapters ?? {}) };
    for (const model of XAI_RESPONSES_OPT_IN_MODELS) {
      if (rawBody.xaiResponsesOptIn) modelAdapters[model] = "openai-responses";
      else delete modelAdapters[model];
    }
    if (Object.keys(modelAdapters).length > 0) next.modelAdapters = modelAdapters;
    else delete next.modelAdapters;
    touched = true;
  }
  if (Object.hasOwn(rawBody, "requestPacing")) {
    const value = rawBody.requestPacing;
    if (value === null) {
      delete next.requestPacing;
    } else {
      if (!isPlainRecord(value)) return { error: "requestPacing must be a plain object or null" };
      const pacingError = requestPacingConfigError(value);
      if (pacingError) return { error: pacingError };
      // `requestPacingConfigError` is the runtime narrowing boundary above; keep the
      // assertion explicit because a generic plain record cannot express `enabled`.
      next.requestPacing = structuredClone(value) as unknown as OcxProviderConfig["requestPacing"];
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "upstreamHttpVersion")) {
    const value = rawBody.upstreamHttpVersion;
    if (value === null || value === "") {
      delete next.upstreamHttpVersion;
    } else {
      const versionError = upstreamHttpVersionConfigError(value);
      if (versionError) return { error: versionError };
      // `upstreamHttpVersionConfigError` is the shared write boundary; the assertion is
      // explicit because the incoming value is an unknown JSON scalar.
      next.upstreamHttpVersion = value as OcxProviderConfig["upstreamHttpVersion"];
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "upstreamWebsocket")) {
    if (typeof rawBody.upstreamWebsocket !== "boolean") return { error: "upstreamWebsocket must be a boolean" };
    next.upstreamWebsocket = rawBody.upstreamWebsocket;
    touched = true;
  }
  // The Models page edits the catalog hints in place; keep them on the existing
  // provider mutation path so validation, cache invalidation, and convergence stay unified (#1073).
  if (Object.hasOwn(rawBody, "contextWindow")) {
    const value = rawBody.contextWindow;
    if (value === null) {
      delete next.contextWindow;
    // `Number.isInteger(1e100)` is true, so an integer check alone admits a value that
    // serializes into the catalog as an enormous number and can make Codex reject the whole
    // file. Safe-integer is the real bound for something that ends up in a JSON int field.
    } else if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      next.contextWindow = value;
    } else {
      return { error: "contextWindow must be a positive safe integer or null" };
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "modelContextWindows")) {
    const value = rawBody.modelContextWindows;
    if (value === null) {
      delete next.modelContextWindows;
    } else {
      if (!isPlainRecord(value)) return { error: "modelContextWindows must be a plain object or null" };
      const windows: Record<string, number> = { ...(next.modelContextWindows ?? {}) };
      for (const [model, window] of Object.entries(value)) {
        if (!model.trim()) return { error: "modelContextWindows keys must be nonblank model ids" };
        if (window === null) {
          delete windows[model];
          continue;
        }
        if (typeof window !== "number" || !Number.isSafeInteger(window) || window <= 0) {
          return { error: "modelContextWindows values must be positive safe integers or null" };
        }
        windows[model] = window;
      }
      if (Object.keys(windows).length > 0) next.modelContextWindows = windows;
      else delete next.modelContextWindows;
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "modelAutoCompactTokenLimits")) {
    const value = rawBody.modelAutoCompactTokenLimits;
    const error = modelAutoCompactTokenLimitsConfigError(value, {
      allowTombstones: true,
      requireNativeIds: name === "openai",
    });
    if (error) return { error };
    if (value === null) {
      delete next.modelAutoCompactTokenLimits;
    } else {
      const budgets: Record<string, number> = Object.assign(
        Object.create(null) as Record<string, number>,
        next.modelAutoCompactTokenLimits ?? {},
      );
      for (const [model, budget] of Object.entries(value as Record<string, number | null>)) {
        if (budget === null) delete budgets[model];
        else budgets[model] = budget;
      }
      if (Object.keys(budgets).length > 0) next.modelAutoCompactTokenLimits = budgets;
      else delete next.modelAutoCompactTokenLimits;
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "modelSupportsServiceTier")) {
    const value = rawBody.modelSupportsServiceTier;
    if (value === null) {
      delete next.modelSupportsServiceTier;
    } else {
      if (!isPlainRecord(value)) return { error: "modelSupportsServiceTier must be a plain object or null" };
      const capabilities: Record<string, boolean> = { ...(next.modelSupportsServiceTier ?? {}) };
      for (const [model, supported] of Object.entries(value)) {
        if (!model.trim()) return { error: "modelSupportsServiceTier keys must be nonblank model ids" };
        if (supported === null) {
          delete capabilities[model];
          continue;
        }
        if (typeof supported !== "boolean") {
          return { error: "modelSupportsServiceTier values must be booleans or null" };
        }
        capabilities[model] = supported;
      }
      if (Object.keys(capabilities).length > 0) next.modelSupportsServiceTier = capabilities;
      else delete next.modelSupportsServiceTier;
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "noStructuredOutputModels")) {
    const value = rawBody.noStructuredOutputModels;
    if (value === null) {
      delete next.noStructuredOutputModels;
    } else {
      const error = nonBlankStringArrayConfigError(value, "noStructuredOutputModels");
      if (error) return { error };
      const models = normalizeNonBlankStringArray(value as string[]);
      if (models.length > 0) next.noStructuredOutputModels = models;
      else delete next.noStructuredOutputModels;
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "retainModels")) {
    const value = rawBody.retainModels;
    if (value === null) {
      delete next.retainModels;
    } else {
      const error = nonBlankStringArrayConfigError(value, "retainModels");
      if (error) return { error };
      const models = normalizeNonBlankStringArray(value as string[]);
      if (models.length > 0) next.retainModels = models;
      else delete next.retainModels;
    }
    touched = true;
  }
  if (Object.hasOwn(rawBody, "omitReasoningEffortWithToolsModels")) {
    const value = rawBody.omitReasoningEffortWithToolsModels;
    if (value === null) {
      delete next.omitReasoningEffortWithToolsModels;
    } else {
      const error = nonBlankStringArrayConfigError(value, "omitReasoningEffortWithToolsModels");
      if (error) return { error };
      const models = normalizeNonBlankStringArray(value as string[]);
      if (models.length > 0) next.omitReasoningEffortWithToolsModels = models;
      else delete next.omitReasoningEffortWithToolsModels;
    }
    touched = true;
  }

  // headers is the one object-valued field in the mask. PATCH semantics merge it
  // shallowly into the existing block so a single fingerprint header can be added
  // without wiping the rest; null or an empty object clears user-managed headers.
  if (Object.hasOwn(rawBody, "headers")) {
    const headersValue = rawBody.headers;
    if (headersValue === null || (isPlainRecord(headersValue) && Object.keys(headersValue).length === 0)) {
      // Registry-owned static metadata (e.g. opencode-free's x-opencode-client marker)
      // is not user-managed: restoring it keeps the upstream transport intact after a
      // clear instead of deleting the whole block.
      const entry = getProviderRegistryEntry(name);
      if (entry?.staticHeaders && providerMatchesRegistryTransport(name, next)) {
        next.headers = { ...entry.staticHeaders };
      } else {
        delete next.headers;
      }
    } else {
      if (!isPlainRecord(headersValue)) return { error: "headers must be an object" };
      const headersError = providerHeadersConfigError(headersValue);
      if (headersError) return { error: headersError };
      // Header names are case-insensitive on the wire. Drop any existing key whose
      // lowercase name collides with an incoming one, or Headers normalization would
      // send a combined "x-custom: v1, v2" value upstream.
      const incoming = new Map(
        Object.entries(headersValue as Record<string, string>).map(([key, value]) => [key.toLowerCase(), [key, value] as const]),
      );
      const merged: Record<string, string> = {};
      for (const [key, value] of Object.entries(next.headers ?? {})) {
        if (!incoming.has(key.toLowerCase())) merged[key] = value;
      }
      for (const [key, value] of incoming.values()) merged[key] = value;
      next.headers = merged;
    }
    touched = true;
    headersTouched = true;
  }

  if (!touched) return { error: "no recognized fields to update" };

  // A disabled-only toggle preserves the v2 fast lane for non-openai providers: it changes
  // routing eligibility, not the provider shape. Re-enabling `openai` is different — a
  // malformed disabled row must not come back online unchanged, so canonicalize/reject
  // against the same built-in gate used by mode PATCH and POST.
  const editorTouched = keys.some(key => key !== "disabled");
  const enablingOpenAi = name === "openai"
    && Object.hasOwn(rawBody, "disabled")
    && rawBody.disabled === false
    && provider.disabled === true;
  if (!editorTouched && enablingOpenAi) {
    if (!isCanonicalOpenAiForwardProvider(next)) {
      return { error: "provider openai must be the canonical built-in provider" };
    }
    // Persist the byte-identical canonical URL so config.ts startup checks (case-sensitive)
    // accept the row after we fill mode. Equivalent hosts like CHATGPT.com/:443 normalize here.
    next.baseUrl = CODEX_FORWARD_BASE_URL;
    // Fill missing mode so a disabled canonical row becomes a complete live openai entry.
    if (next.codexAccountMode !== "pool" && next.codexAccountMode !== "direct") {
      next.codexAccountMode = "pool";
    }
    if (next.disabled === false) delete next.disabled;
    // Canonical openai never uses private-network opt-in; drop a stale flag that
    // was ignored for the DNS probe so it cannot linger on the live row.
    delete next.allowPrivateNetwork;
  }
  return { next, touched, editorTouched, enablingOpenAi, headersTouched };
}

/** Validate the canonical OpenAI soft-budget overlay against a fresh registry seed. */
function canonicalOpenAiBudgetPatchError(
  provider: OcxProviderConfig,
  rawBody: Record<string, unknown>,
  keys: string[],
  config: OcxConfig,
): string | null {
  if (!isCanonicalOpenAiForwardProvider(provider)) {
    return "provider openai must be the canonical built-in provider";
  }
  const entry = getProviderRegistryEntry("openai");
  if (!entry) return "provider openai registry seed is unavailable";
  const seed = providerConfigSeed(entry);
  if (provider.codexAccountMode !== undefined) seed.codexAccountMode = provider.codexAccountMode;
  if (provider.modelAutoCompactTokenLimits !== undefined) {
    seed.modelAutoCompactTokenLimits = { ...provider.modelAutoCompactTokenLimits };
  }
  const applied = applyProviderPatchFields("openai", seed, rawBody, keys, config);
  if ("error" in applied) return applied.error;
  return providerManagementConfigError("openai", applied.next)
    ?? providerEmptyToolOutputConfigError("openai", applied.next);
}

export async function handleProviderRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps, principal, convergeCodexCatalog, syncClaudeAgentDefsBestEffort } = ctx;

  if (url.pathname === "/api/provider-quotas" && req.method === "GET") {
    const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
    return jsonResponse(await fetchProviderQuotaReports(config, forceRefresh));
  }

  if (url.pathname === "/api/provider-request-pacing" && req.method === "GET") {
    const name = url.searchParams.get("name")?.trim();
    if (name) {
      if (!isValidProviderName(name) || !hasOwnProvider(config.providers, name)) {
        return jsonResponse({ error: "unknown provider" }, 404);
      }
      return jsonResponse(providerRequestPacingStatus(name, config.providers[name]!));
    }
    return jsonResponse(Object.fromEntries(
      Object.entries(config.providers).map(([providerName, provider]) => [
        providerName,
        providerRequestPacingStatus(providerName, provider),
      ]),
    ));
  }

  if (url.pathname === "/api/providers" && req.method === "GET") {
    return jsonResponse(Object.entries(config.providers).map(([name, p]) => ({
      name, adapter: p.adapter, baseUrl: publicProviderBaseUrl(p.baseUrl), defaultModel: p.defaultModel,
      hasApiKey: !!p.apiKey,
      // Presence only (#959 review): header names and values never leave the process.
      hasHeaders: !!p.headers && Object.keys(p.headers).length > 0,
      allowPrivateNetwork: p.allowPrivateNetwork === true,
      liveModels: p.liveModels !== false,
      requestPacing: p.requestPacing,
      models: p.models ?? [],
      contextWindow: p.contextWindow,
      modelContextWindows: p.modelContextWindows,
      modelAutoCompactTokenLimits: p.modelAutoCompactTokenLimits,
      modelSupportsServiceTier: p.modelSupportsServiceTier,
      noStructuredOutputModels: p.noStructuredOutputModels,
      retainModels: p.retainModels,
      omitReasoningEffortWithToolsModels: p.omitReasoningEffortWithToolsModels,
      upstreamHttpVersion: p.upstreamHttpVersion,
      upstreamWebsocket: p.upstreamWebsocket === true,
      authMode: p.authMode,
      apiKeyTransport: p.apiKeyTransport,
      disabled: p.disabled === true,
      codexAccountMode: providerCodexAccountMode(name, p),
      ...(name === "xai" ? { xaiResponsesOptInState: xaiResponsesOptInState(p) } : {}),
      discovery: p.liveModels === false ? undefined : getProviderDiscoveryStatus(name),
      ...(name === "openai" && isCanonicalOpenAiForwardProvider(p)
        ? { entitlement: getCodexModelEntitlementStatus(config) }
        : {}),
    })));
  }

  if (url.pathname === LOCAL_PROVIDER_RELOAD_PATH && req.method === "POST") {
    if (principal !== "local-provider-reload-capability") {
      return jsonResponse({ error: "provider reload capability required" }, 403);
    }
    const name = req.headers.get(LOCAL_PROVIDER_RELOAD_NAME_HEADER) ?? "";
    if (!isValidProviderName(name)) return jsonResponse({ error: "invalid provider reload target" }, 400);

    const admitted = readConfigAdmissionSnapshot();
    if (
      admitted.kind !== "read"
      || admitted.diagnostics.source !== "file"
      || admitted.diagnostics.error !== null
    ) {
      return jsonResponse({ error: "provider reload source unavailable" }, 409);
    }
    const diskConfig = admitted.diagnostics.config;
    if (!hasOwnProvider(diskConfig.providers, name)) {
      return jsonResponse({ error: "provider reload target unavailable" }, 404);
    }
    const provider = diskConfig.providers[name]!;
    const providerError = providerManagementConfigError(
      name,
      providerTransportValidationCandidate(provider as unknown as Record<string, unknown>),
    )
      ?? providerEmptyToolOutputConfigError(name, provider);
    if (providerError) return jsonResponse({ error: "provider reload target invalid" }, 409);
    const namespaceCollision = codexAccountNamespaceProviderCollisionError(
      diskConfig.codexAccountNamespaces,
      name,
    );
    if (namespaceCollision) return jsonResponse({ error: "provider reload target conflicts with routing" }, 409);
    const allowBenchmarkAddresses = name === "openai" && isCanonicalOpenAiForwardProvider(provider);
    const resolvedError = await providerDestinationResolvedError(name, provider, { allowBenchmarkAddresses });
    if (resolvedError) return jsonResponse({ error: "provider reload target rejected" }, 409);

    // Destination validation awaits DNS. A cooperating writer holds the same SQLite
    // mutation lock, so the final exact-byte check and live adoption happen as one
    // synchronous authority decision. The route does not save or reserialize disk.
    let currentDiskConfig: OcxConfig | null = null;
    let sourceChanged = false;
    withConfigMutationLockSync(() => {
      const current = readConfigAdmissionSnapshot();
      if (
        current.kind !== "read"
        || current.diagnostics.source !== "file"
        || current.diagnostics.error !== null
        || current.contentSha256 !== admitted.contentSha256
      ) {
        sourceChanged = true;
        return;
      }
      currentDiskConfig = current.diagnostics.config;
      adoptPersistedProviderIntoLiveConfig(
        config,
        name,
        current.diagnostics.config.providers[name]!,
        current.diagnostics.config,
      );
    });
    if (sourceChanged || currentDiskConfig === null) {
      return jsonResponse({ error: "provider reload source changed" }, 409);
    }
    reconcileLiveStateStores();
    // The complete disk snapshot owns display overlays, including providers that this
    // live routing instance deliberately does not adopt.
    refreshUserCostOverlays(currentDiskConfig);
    clearGatherRoutedModelsInflight();
    (deps.clearProviderQuotaCache ?? clearProviderQuotaCache)();
    clearAccountQuotaCache(name);
    clearKeyCooldowns(name);
    clearModelCache(name);
    if (name === "openai") (deps.clearThreadAccountMap ?? clearThreadAccountMap)();
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ success: true, name, catalogRefresh });
  }

  if (url.pathname === "/api/providers" && req.method === "PUT") {
    let rawBody: unknown;
    try {
      rawBody = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    if (!isPlainRecord(rawBody)) {
      return jsonResponse({ error: "provider batch body must be a plain object", code: "invalid_provider_editor_body" }, 400);
    }
    const bodyKeys = Object.keys(rawBody);
    if (bodyKeys.length !== 2 || !Object.hasOwn(rawBody, "baseline") || !Object.hasOwn(rawBody, "next")) {
      return jsonResponse({ error: "provider batch body must contain only baseline and next", code: "invalid_provider_editor_body" }, 400);
    }
    const baselineResult = parseProviderEditorConfigDTO(rawBody.baseline);
    if (!baselineResult.ok) return jsonResponse({ error: baselineResult.error, code: baselineResult.code }, 400);
    const nextResult = parseProviderEditorConfigDTO(rawBody.next);
    if (!nextResult.ok) return jsonResponse({ error: nextResult.error, code: nextResult.code }, 400);

    const observed = readConfigAdmissionSnapshot();
    if (observed.kind !== "read" || observed.diagnostics.source !== "file" || observed.diagnostics.error !== null) {
      return jsonResponse({ error: "provider config is unavailable", code: "provider_config_unavailable" }, 409);
    }
    if (!isDeepStrictEqual(providerEditorConfigDTO(observed.diagnostics.config), baselineResult.value)) {
      return jsonResponse({ error: "provider editor baseline is stale", code: "stale_provider_editor_baseline" }, 409);
    }
    const preview = providerEditorCandidate(observed.diagnostics.config, baselineResult.value, nextResult.value);
    if (!preview.ok) return jsonResponse({ error: preview.error, code: preview.code }, preview.status);

    // DNS/SSRF validation happens before the persistence callback. The callback repeats every
    // synchronous check against a fresh snapshot and rejects a changed baseline, so this awaited
    // phase can never authorize a stale provider set.
    for (const [name, provider] of Object.entries(preview.config.providers)) {
      const allowBenchmarkAddresses = name === "openai" && isCanonicalOpenAiForwardProvider(provider);
      const resolvedError = await providerDestinationResolvedError(name, provider, { allowBenchmarkAddresses });
      if (resolvedError) return jsonResponse({ error: resolvedError, code: "invalid_provider_destination" }, 400);
    }

    const outcome = mutatePersistedConfig<ProviderEditorMutationValue>(persisted => {
      if (!isDeepStrictEqual(providerEditorConfigDTO(persisted), baselineResult.value)) {
        return {
          changed: false,
          value: {
            ok: false,
            status: 409,
            error: "provider editor baseline is stale",
            code: "stale_provider_editor_baseline",
          },
        };
      }
      const candidate = providerEditorCandidate(persisted, baselineResult.value, nextResult.value);
      if (!candidate.ok) return { changed: false, value: candidate };
      const changed = !isDeepStrictEqual(providerEditorConfigDTO(persisted), nextResult.value);
      if (!changed) return { changed: false, value: candidate };

      persisted.defaultProvider = candidate.config.defaultProvider;
      persisted.providers = structuredClone(candidate.config.providers);
      for (const name of candidate.removedProviders) {
        dropProviderCustomModels(persisted, name);
        setProviderContextCap(persisted, name, false);
      }
      return {
        changed: true,
        value: {
          ok: true,
          config: structuredClone(persisted),
          removedProviders: candidate.removedProviders,
        },
      };
    });
    if (outcome.status === "unavailable") {
      const code = outcome.reason === "conflict" ? "provider_config_conflict" : "provider_config_unavailable";
      return jsonResponse({ error: "provider config changed before it could be saved", code }, 409);
    }
    if (!outcome.value.ok) {
      return jsonResponse({ error: outcome.value.error, code: outcome.value.code }, outcome.value.status);
    }

    adoptProviderEditorCandidate(config, outcome.value.config);
    reconcileLiveStateStores();
    refreshUserCostOverlays(outcome.value.config);
    clearGatherRoutedModelsInflight();
    (deps.clearProviderQuotaCache ?? clearProviderQuotaCache)();
    clearAccountQuotaCache();
    clearKeyCooldowns();
    clearModelCache();
    (deps.clearThreadAccountMap ?? clearThreadAccountMap)();
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ success: true, catalogRefresh });
  }

  // Add (or overwrite) a single provider. Merges into the live in-memory config and
  // persists — existing providers' real keys are never round-tripped (unlike PUT /api/config,
  // which would re-save the masked keys from GET). Live routing picks it up immediately.
  if (url.pathname === "/api/providers" && req.method === "POST") {
    let body: { name?: unknown; provider?: unknown; setDefault?: boolean };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!isPlainRecord(body.provider)) return jsonResponse({ error: "provider must be a plain object" }, 400);
    const existing = config.providers[name];
    const aliasOwnershipError = providerAliasOverlayOwnershipError(body.provider, existing);
    if (aliasOwnershipError) return jsonResponse({ error: aliasOwnershipError }, 400);
    const transportCandidate = providerTransportValidationCandidate(body.provider);
    const providerError = providerManagementConfigError(name, transportCandidate)
      ?? providerEmptyToolOutputConfigError(name, transportCandidate);
    if (providerError) return jsonResponse({ error: providerError }, 400);
    const rawProvider = body.provider as Record<string, unknown>;
    if (rawProvider.upstreamWebsocket !== undefined && typeof rawProvider.upstreamWebsocket !== "boolean") {
      return jsonResponse({ error: "upstreamWebsocket must be a boolean" }, 400);
    }
    const serviceTierError = providerServiceTierConfigError(name, transportCandidate);
    if (serviceTierError) return jsonResponse({ error: serviceTierError }, 400);
    const prov = stripCodexRuntimeProviderFields(transportCandidate as unknown as OcxProviderConfig);
    // PATCH already clears on null; POST persisted the body as submitted, so a `null` here
    // reached disk and the next loadConfig() refused it. Canonicalize to absent, which is what
    // "clear" means everywhere else.
    if (prov && prov.upstreamHttpVersion === null) delete prov.upstreamHttpVersion;
    if (!name || !prov?.adapter || !prov?.baseUrl) {
      return jsonResponse({ error: "name, provider.adapter and provider.baseUrl are required" }, 400);
    }
    const displayNamesError = modelDisplayNamesConfigError(prov.modelDisplayNames);
    if (displayNamesError) return jsonResponse({ error: displayNamesError }, 400);
    if (!isValidProviderName(name)) {
      return jsonResponse({ error: "provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key" }, 400);
    }
    const namespaceCollision = codexAccountNamespaceProviderCollisionError(config.codexAccountNamespaces, name);
    if (namespaceCollision) {
      return jsonResponse({ error: namespaceCollision }, 409);
    }
    // Hostname destinations additionally get a DNS-resolved SSRF check at write time —
    // the sync check above only classifies literal IPs (review finding, PR #96).
    // Canonical openai still runs the resolver: only Clash fake-IP (198.18.0.0/15)
    // answers are ignored; loopback/RFC1918/metadata/mixed sets still fail.
    const allowBenchmarkAddresses = name === "openai" && isCanonicalOpenAiForwardProvider(prov);
    const resolvedError = await providerDestinationResolvedError(name, prov, { allowBenchmarkAddresses });
    if (resolvedError) return jsonResponse({ error: resolvedError }, 400);
    if (body.setDefault !== undefined && typeof body.setDefault !== "boolean") {
      return jsonResponse({ error: "setDefault must be a boolean" }, 400);
    }
    if (body.setDefault === true && prov.disabled) {
      return jsonResponse({ error: "cannot set a disabled provider as default", code: "default_provider_disabled" }, 400);
    }
    // Catalog providers (e.g. ollama-cloud) carry a models + vision/reasoning classification the GUI
    // doesn't send — merge it in so the sidecars are gated correctly.
    // Sample request ownership BEFORE enrichment. Enrichment fills absent fields from the
    // registry seed, after which "the client omitted this" and "the registry supplied it" are
    // indistinguishable — so a carry-over guard written as `prov.x === undefined` after this
    // call can never fire.
    const submittedContextWindow = Object.hasOwn(prov, "contextWindow");
    const submittedModelContextWindows = Object.hasOwn(prov, "modelContextWindows");
    const submittedModelAutoCompactTokenLimits = Object.hasOwn(prov, "modelAutoCompactTokenLimits");
    const submittedModelDisplayNames = Object.hasOwn(prov, "modelDisplayNames");
    const submittedRequestPacing = Object.hasOwn(prov, "requestPacing");
    const submittedUpstreamWebsocket = Object.hasOwn(prov, "upstreamWebsocket");
    // Same trap, one more field: DeepSeek carries a registry default of `true` for
    // annotateEmptyToolOutputs, so enrichment cannot distinguish "the client omitted it"
    // from "the registry supplied it" either. Without this sample, an unrelated edit that
    // omits the key resurrects the registry default over an operator's explicit `false`.
    const submittedAnnotateEmptyToolOutputs = Object.hasOwn(prov, "annotateEmptyToolOutputs");
    enrichProviderFromCatalog(name, prov);
    const { saveConfigPreservingClaudeCode: save } = await import("../../config");
    // Overwriting an existing provider must not drop its multi-key pool: carry it over, then
    // let the (possibly new) apiKey join the pool as the active entry.
    const existingPool = config.providers[name]?.apiKeyPool;
    if (existingPool && !prov.apiKeyPool) prov.apiKeyPool = existingPool;
    // The same rule applies to user-configured price overlays: the dashboard's
    // add/edit form does not send modelCosts, so an overwrite must not silently
    // erase hand-edited per-model prices from Logs/Usage estimates.
    const existingCosts = config.providers[name]?.modelCosts;
    if (existingCosts && !prov.modelCosts) prov.modelCosts = existingCosts;
    // And to the per-provider account-failover opt-out (#2568d). `ProviderPayload` has no
    // member for it either, so an add/edit save structurally cannot carry it — and dropping it
    // silently ENABLES rotation, because activation is presence-driven once the knob is gone.
    // An overwrite must not spend a second subscription account's quota as a side effect.
    const existingFailover = config.providers[name]?.oauthAccountFailover;
    if (existingFailover && !prov.oauthAccountFailover) prov.oauthAccountFailover = existingFailover;
    // ...and to hand-edited context windows. `ProviderPayload` (gui/src/provider-payload.ts)
    // has no member for either field, so the add/edit form structurally cannot send them:
    // absence in the request means "not carried", never "the user deleted it". Deletion goes
    // through PATCH with an explicit null (#1409).
    if (!submittedModelDisplayNames && existing?.modelDisplayNames) {
      prov.modelDisplayNames = { ...existing.modelDisplayNames };
    }
    if (!submittedRequestPacing && existing?.requestPacing) {
      prov.requestPacing = structuredClone(existing.requestPacing);
    }
    if (!submittedContextWindow && existing?.contextWindow !== undefined) {
      prov.contextWindow = existing.contextWindow;
    }
    // `!== undefined` rather than a truthiness test: the whole point of this field is that
    // an explicit `false` must survive, and `false` is falsy.
    if (!submittedAnnotateEmptyToolOutputs && existing?.annotateEmptyToolOutputs !== undefined) {
      prov.annotateEmptyToolOutputs = existing.annotateEmptyToolOutputs;
    }
    // The provider add/edit form may omit this transport option. Preserve the stored value
    // during a full overwrite; PATCH remains the explicit mutation path, and `!== undefined`
    // keeps an operator's explicit false from being treated as absent.
    if (!submittedUpstreamWebsocket && existing?.upstreamWebsocket !== undefined) {
      prov.upstreamWebsocket = existing.upstreamWebsocket;
    }
    if (existing?.modelContextWindows) {
      // When the client did send a map, its keys win and the user's other keys survive. When
      // it did not, the stored value is the user's map alone: merging the registry seed in
      // would persist seed keys into user config as a side effect of an unrelated save, and
      // router.ts already fills registry values beneath user entries at resolve time.
      prov.modelContextWindows = submittedModelContextWindows
        ? { ...existing.modelContextWindows, ...(prov.modelContextWindows ?? {}) }
        : { ...existing.modelContextWindows };
    }
    if (existing?.modelAutoCompactTokenLimits) {
      prov.modelAutoCompactTokenLimits = submittedModelAutoCompactTokenLimits
        ? { ...existing.modelAutoCompactTokenLimits, ...(prov.modelAutoCompactTokenLimits ?? {}) }
        : { ...existing.modelAutoCompactTokenLimits };
    }
    // DNS validation above awaits. Re-read the live row so a dedicated alias write that
    // completed during that wait remains authoritative instead of being overwritten by the
    // older ownership snapshot used to admit this POST.
    restorePersistedAliasOverlays(prov, config.providers[name]);
    config.providers[name] = stripRegistryOnlyStaticHeaders(name, prov);
    if (body.setDefault === true) config.defaultProvider = name;
    save(config);
    reconcileLiveStateStores();
    if (prov.apiKey && prov.apiKeyPool) {
      const { addProviderApiKey } = await import("../../providers/api-keys");
      addProviderApiKey(config, name, prov.apiKey);
    }
    const { clearModelCache } = await import("../../codex/model-cache");
    clearModelCache(name);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ success: true, name, catalogRefresh });
  }

  if (url.pathname === "/api/providers" && req.method === "PATCH") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    let rawBody: unknown;
    try { rawBody = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(rawBody)) return jsonResponse({ error: "provider patch body must be a plain object" }, 400);
    const keys = Object.keys(rawBody);
    const aliasField = PROVIDER_ALIAS_OVERLAY_FIELDS.find(field => Object.hasOwn(rawBody, field));
    if (aliasField) return jsonResponse({ error: `${aliasField} is managed by the dedicated alias API` }, 400);
    const hasMode = Object.hasOwn(rawBody, "codexAccountMode");
    const hasSetDefault = Object.hasOwn(rawBody, "setDefault");
    const canonicalBudgetOnly = name === "openai"
      && keys.length === 1
      && keys[0] === "modelAutoCompactTokenLimits";

    // codexAccountMode keeps its dedicated side-effect path (quota cache clear, thread map
    // clear, pool prime) and is mutually exclusive with every other patch field.
    if (hasMode) {
      if (keys.length !== 1) {
        return jsonResponse({ error: "codexAccountMode cannot be combined with other patch fields" }, 400);
      }
      if (name !== "openai") return jsonResponse({ error: "codexAccountMode is valid only for provider openai" }, 400);
      const mode = rawBody.codexAccountMode;
      if (mode !== "pool" && mode !== "direct") {
        return jsonResponse({ error: "codexAccountMode must be pool or direct" }, 400);
      }
      const provider = config.providers.openai;
      if (!provider || !isCanonicalOpenAiForwardProvider(provider)) {
        return jsonResponse({ error: "provider openai must be the canonical built-in provider" }, 400);
      }
      const { saveConfigPreservingClaudeCode: save } = await import("../../config");
      config.providers.openai = { ...provider, codexAccountMode: mode };
      save(config);
      reconcileLiveStateStores();
      (deps.clearProviderQuotaCache ?? clearProviderQuotaCache)();
      (deps.clearThreadAccountMap ?? clearThreadAccountMap)();
      if (mode === "pool") {
        try {
          const prime = deps.primeCodexPoolQuotas ?? primeCodexPoolQuotas;
          void Promise.resolve(prime(config, "mode-change")).catch(() => undefined);
        } catch {
          // Quota priming is best-effort; the persisted live mode is already authoritative.
        }
      }
      return jsonResponse({ success: true, name: "openai", codexAccountMode: mode });
    }

    // Default-provider changes must be a deliberate, standalone action. This keeps
    // routing changes out of ordinary provider edits and lets the dashboard expose a
    // simple "Set as default" control without round-tripping the full config.
    if (hasSetDefault) {
      if (keys.length !== 1 || rawBody.setDefault !== true) {
        return jsonResponse({ error: "setDefault must be true and cannot be combined with other patch fields" }, 400);
      }
      if (config.providers[name]!.disabled) {
        return jsonResponse({ error: "cannot set a disabled provider as default", code: "default_provider_disabled" }, 400);
      }
      const { saveConfigPreservingClaudeCode: save } = await import("../../config");
      config.defaultProvider = name;
      save(config);
      reconcileLiveStateStores();
      return jsonResponse({ success: true, name, defaultProvider: name });
    }

    // Field-mask editor: apply recognized fields onto a copy, then validate the MERGED
    // provider (canonical-seed guard covers openai; local-guard covers registry key providers).
    // API keys are never writable here — the api-keys endpoints own pool-integrated key writes.
    if (Object.hasOwn(rawBody, "apiKey")) {
      return jsonResponse({ error: "apiKey cannot be patched here; use the provider API-key endpoints" }, 400);
    }
    const applied = applyProviderPatchFields(name, config.providers[name]!, rawBody, keys, config);
    if ("error" in applied) return jsonResponse({ error: applied.error }, 400);
    const next = applied.next;

    const pacingOnly = keys.every(key => key === "requestPacing");
    if (applied.editorTouched && !pacingOnly) {
      const providerError = canonicalBudgetOnly
        ? canonicalOpenAiBudgetPatchError(next, rawBody, keys, config)
        : providerManagementConfigError(
            name,
            providerTransportValidationCandidate(next as unknown as Record<string, unknown>),
          )
          ?? providerEmptyToolOutputConfigError(name, next);
      if (providerError) return jsonResponse({ error: providerError }, 400);
      if (!canonicalBudgetOnly) {
        const serviceTierError = providerServiceTierConfigError(name, next);
        if (serviceTierError) return jsonResponse({ error: serviceTierError }, 400);
        // Same DNS gate as POST and re-enable: the canonical built-in OpenAI forward
        // provider may resolve through Clash/Mihomo fake-IP DNS (198.18.0.0/15), so the
        // ordinary PATCH must not reject the very same destination the provider was
        // created with. Loopback, RFC1918, metadata, and mixed dangerous answers still
        // fail closed; nothing else gains the exception.
        const allowBenchmarkAddresses = name === "openai" && isCanonicalOpenAiForwardProvider(next);
        const resolvedError = await providerDestinationResolvedError(name, next, { allowBenchmarkAddresses });
        if (resolvedError) return jsonResponse({ error: resolvedError }, 400);
      }
    } else if (applied.enablingOpenAi) {
      // Same DNS gate as POST: Clash fake-IP only. Never honor a persisted
      // allowPrivateNetwork on this path — it must not bypass the built-in guard.
      const resolvedError = await providerDestinationResolvedError(
        "openai",
        { baseUrl: CODEX_FORWARD_BASE_URL },
        { allowBenchmarkAddresses: true },
      );
      if (resolvedError) return jsonResponse({ error: resolvedError }, 400);
    }

    // The live config is shared and the destination probe above is awaited. Re-apply the
    // mask onto the newest provider under the mutation lock right before saving, so two
    // concurrent PATCHes updating different fields/headers both survive instead of the
    // later save clobbering the earlier snapshot.
    let replayError: string | undefined;
    withConfigMutationLockSync(() => {
      const replay = applyProviderPatchFields(name, config.providers[name]!, rawBody, keys, config);
      if ("error" in replay) {
        replayError = replay.error;
        return;
      }
      if (replay.editorTouched && !pacingOnly) {
        const syncError = canonicalBudgetOnly
          ? canonicalOpenAiBudgetPatchError(replay.next, rawBody, keys, config)
          : providerManagementConfigError(
              name,
              providerTransportValidationCandidate(replay.next as unknown as Record<string, unknown>),
            )
            ?? providerEmptyToolOutputConfigError(name, replay.next);
        if (syncError) {
          replayError = syncError;
          return;
        }
        if (!canonicalBudgetOnly) {
          const serviceTierError = providerServiceTierConfigError(name, replay.next);
          if (serviceTierError) {
            replayError = serviceTierError;
            return;
          }
        }
      } else if (replay.enablingOpenAi && !isCanonicalOpenAiForwardProvider(replay.next)) {
        replayError = "provider openai must be the canonical built-in provider";
        return;
      }
      // A PATCH that managed headers owns the resulting block: the clear path restores
      // registry static headers, so exact-match stripping must not erase them again.
      config.providers[name] = replay.headersTouched ? replay.next : stripRegistryOnlyStaticHeaders(name, replay.next);
      saveConfigPreservingClaudeCode(config);
    });
    if (replayError !== undefined) return jsonResponse({ error: replayError }, 409);
    reconcileLiveStateStores();
    if (applied.editorTouched && !pacingOnly) {
      const { clearModelCache } = await import("../../codex/model-cache");
      clearModelCache(name);
    }
    const catalogRefresh = pacingOnly ? null : await convergeCodexCatalog();
    return jsonResponse({
      success: true,
      name,
      disabled: config.providers[name]!.disabled === true,
      hasApiKey: !!config.providers[name]!.apiKey,
      ...(name === "xai"
        ? { xaiResponsesOptInState: xaiResponsesOptInState(config.providers[name]!) }
        : {}),
      catalogRefresh,
    });
  }

  // Lightweight connectivity probe: perform the provider's live /models fetch DIRECTLY and
  // report only real upstream evidence. The catalog aggregate (fetchAllModels) deliberately
  // hides fetch failures behind stale/static fallbacks, so a catalog-presence check would
  // let a static-catalog provider with a fake key "pass" — this endpoint never uses it.
  if (url.pathname === "/api/providers/test" && req.method === "POST") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) {
      return jsonResponse({ error: "unknown provider" }, 404);
    }
    const prov = config.providers[name]!;
    if (prov.disabled) {
      return jsonResponse({ ok: false, error: "Provider is disabled", latencyMs: 0 });
    }
    if (prov.authMode === "forward") {
      return jsonResponse({
        ok: true,
        latencyMs: 0,
        message: "Passthrough provider is configured (forwards your Codex login; no upstream /models).",
      });
    }
    if (prov.liveModels === false) {
      // A static catalog has no live discovery endpoint to test. This is neither
      // positive connectivity evidence nor an outage, and it must stay before
      // credential resolution/network access for providers such as Antigravity.
      return jsonResponse({ applicable: false, reason: "static_catalog", latencyMs: 0 });
    }
    const { buildModelsRequest, getValidAccessTokenSnapshot, resolveModelsAuthToken } = await import("../../oauth");
    const antigravity = effectiveGoogleMode(name, prov) === "cloud-code-assist";
    const snapshot = antigravity
      ? await getValidAccessTokenSnapshot(name).catch(() => undefined)
      : undefined;
    const apiKey = snapshot?.accessToken ?? await resolveModelsAuthToken(name, prov);
    if (prov.authMode === "oauth" && !apiKey) {
      return jsonResponse({ ok: false, latencyMs: 0, error: "static catalog only — upstream not verified (not logged in)" });
    }
    if (prov.adapter === "cursor") {
      const started = Date.now();
      const live = await fetchCursorUsableModels({
        apiKey: apiKey ?? "",
        baseUrl: prov.baseUrl,
      });
      const latencyMs = Date.now() - started;
      if (!live.ok) {
        return jsonResponse({
          ok: false,
          latencyMs,
          error: `cursor discovery ${live.error}${live.detail ? `: ${live.detail}` : ""}`,
        });
      }
      return jsonResponse({
        ok: true,
        latencyMs,
        models: live.models.length,
        message: `Connected. ${live.models.length} models.`,
      });
    }
    const project = prov.project ?? snapshot?.projectId;
    if (antigravity && !project) {
      return jsonResponse({ ok: false, latencyMs: 0, error: "Antigravity project unavailable — re-run `ocx login google-antigravity`" });
    }
    const { method, url: modelsUrl, headers } = buildModelsRequest(prov, apiKey, name);
    const discovery = resolveProviderModelDiscovery(name, prov);
    const started = Date.now();
    try {
      const res = method === "POST"
        ? await providerOutboundPost(name, prov, modelsUrl, {
          headers,
          body: JSON.stringify({ project }),
          signal: AbortSignal.timeout(8000),
        })
        : await providerOutboundGet(name, prov, modelsUrl, {
          headers,
          signal: AbortSignal.timeout(8000),
        });
      const latencyMs = Date.now() - started;
      const redirectError = await providerRedirectError(res, modelsUrl);
      if (redirectError) {
        return jsonResponse({
          ok: false,
          latencyMs,
          error: redirectError,
        });
      }
      if (!res.ok) {
        try {
          void res.body?.cancel().catch(() => undefined);
        } catch {
          // Best-effort release for non-conforming response streams.
        }
        return jsonResponse({ ok: false, latencyMs, error: `upstream model discovery returned ${res.status}` });
      }
      const bounded = await readBoundedDiscoveryJson(res, discovery.maxResponseBytes);
      if (!bounded.ok) {
        return jsonResponse({
          ok: false,
          latencyMs,
          error: bounded.reason === "response_too_large"
              ? `upstream model discovery exceeded the ${discovery.maxResponseBytes}-byte response limit`
              : "upstream model discovery returned invalid JSON",
        });
      }
      const ccaModels = antigravity ? parseAntigravityAvailableModels(bounded.value, discovery.maxModels) : undefined;
      if (antigravity && !ccaModels) {
        return jsonResponse({ ok: false, latencyMs, error: "upstream CCA model discovery returned an unexpected shape" });
      }
      // OpenAI-style lists (and Together top-level arrays) use the same validation/dedupe/filter
      // as catalog discovery. Google's /v1beta/models uses `models[].name` and remains a
      // connectivity-only count because it is not an authoritative catalog source.
      const record = bounded.value !== null && typeof bounded.value === "object" && !Array.isArray(bounded.value)
        ? bounded.value as Record<string, unknown>
        : undefined;
      const extracted = ccaModels
        ? undefined
        : Array.isArray(bounded.value) || Array.isArray(record?.data)
        ? extractProviderModelItems(bounded.value, discovery)
        : extractModelEnvelopeRows(bounded.value, discovery.maxModels, ["models"]);
      if (extracted && !extracted.ok) {
        return jsonResponse({
          ok: false,
          latencyMs,
          error: extracted.reason === "too_many_models"
            ? `upstream /models exceeded the ${discovery.maxModels}-row model limit`
            : "upstream /models returned an unexpected shape",
        });
      }
      const models = ccaModels?.length ?? ("items" in extracted! ? extracted!.items.length : extracted!.rows.length);
      return jsonResponse({
        ok: true,
        latencyMs,
        models,
        message: `Connected — ${models} model${models === 1 ? "" : "s"} available.`,
      });
    } catch (err) {
      return jsonResponse({
        ok: false,
        latencyMs: Date.now() - started,
        error: err instanceof ProviderOutboundPolicyError
          ? `upstream /models blocked by destination policy: ${err.message}`
          : err instanceof Error ? err.message : "Connection test failed",
      });
    }
  }

  if (url.pathname === "/api/providers" && req.method === "DELETE") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    // Config validation requires a default provider. Reassigning before deletion keeps
    // the persisted config valid and makes removal of the current default a one-step UI
    // operation. Prefer the first remaining *enabled* provider so DELETE cannot leave a
    // disabled default that setDefault / disable already refuse. Object-key order is the
    // documented configuration order and is stable through JSON persistence.
    const fallbackDefault = name === config.defaultProvider
      ? Object.entries(config.providers)
        .find(([provider, providerConfig]) => provider !== name && providerConfig.disabled !== true)
        ?.[0]
      : undefined;
    if (name === config.defaultProvider && !fallbackDefault) {
      return jsonResponse({
        error: "cannot delete the default provider when no enabled replacement remains",
        code: "last_provider",
      }, 409);
    }
    const dependentCombos = Object.entries(config.combos ?? {})
      .filter(([, combo]) => combo.targets.some(target => target.provider === name))
      .map(([id]) => id)
      .sort((a, b) => a.localeCompare(b));
    if (dependentCombos.length > 0) {
      return jsonResponse({
        error: `cannot delete provider "${name}" while combos depend on it`,
        code: "provider_has_dependent_combos",
        combos: dependentCombos,
      }, 409);
    }
    const { saveConfigPreservingClaudeCode: save } = await import("../../config");
    if (fallbackDefault) config.defaultProvider = fallbackDefault;
    delete config.providers[name];
    const { dropProviderCustomModels } = await import("../../providers/provider-id-rewrite");
    const droppedCustomModels = dropProviderCustomModels(config, name);
    setProviderContextCap(config, name, false);
    save(config);
    await replaceProviderAccountSet(name, null);
    reconcileLiveStateStores();
    const { clearModelCache: clearCache } = await import("../../codex/model-cache");
    clearCache(name);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({
      success: true,
      ...(fallbackDefault ? { defaultProvider: fallbackDefault } : {}),
      ...(droppedCustomModels > 0 ? { droppedCustomModels } : {}),
      catalogRefresh,
    });
  }

  if (url.pathname === "/api/provider-context-caps" && req.method === "GET") {
    return jsonResponse({ cap: DEFAULT_PROVIDER_CONTEXT_CAP, value: globalContextCapValue(config), caps: providerContextCaps(config) });
  }

  if (url.pathname === "/api/provider-context-caps" && req.method === "PUT") {
    let rawBody: unknown;
    try { rawBody = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    // Reject non-object payloads (e.g. `{"provider": true}` or a bare array) before any
    // property access, with the route's consistent 400 response.
    if (!isPlainRecord(rawBody)) return jsonResponse({ error: "provider-context-caps body must be a plain object" }, 400);
    const body = rawBody as { provider?: unknown; enabled?: unknown; value?: unknown; setAll?: unknown };
    const { saveConfigPreservingClaudeCode: save } = await import("../../config");
    const { clearModelCache } = await import("../../codex/model-cache");
    const respond = (catalogRefresh: Awaited<ReturnType<typeof convergeCodexCatalog>>) => jsonResponse({
      ok: true,
      cap: DEFAULT_PROVIDER_CONTEXT_CAP,
      value: globalContextCapValue(config),
      caps: providerContextCaps(config),
      catalogRefresh,
    });

    // Reject malformed and mixed payloads before branch selection: `provider` and `enabled`
    // must appear together with their expected types, and provider updates cannot be
    // combined with `setAll` (which would otherwise be silently ignored).
    const hasProviderFields = Object.hasOwn(body, "provider") || Object.hasOwn(body, "enabled");
    if (hasProviderFields) {
      if (typeof body.provider !== "string" || typeof body.enabled !== "boolean") {
        return jsonResponse({ error: "provider and enabled are required together" }, 400);
      }
      if (Object.hasOwn(body, "setAll")) {
        return jsonResponse({ error: "setAll cannot be combined with provider updates" }, 400);
      }
    }

    // Branch 1: per-provider toggle (checked first: a per-provider request may carry an
    // explicit `value`, which must never fall through to the global-value branch). Enable
    // writes the current global default unless an explicit per-provider value is supplied;
    // that value is never copied to other providers.
    if (typeof body.provider === "string" && typeof body.enabled === "boolean") {
      const provider = body.provider.trim();
      if (!isValidProviderName(provider)) {
        return jsonResponse({ error: "provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key" }, 400);
      }
      if (!hasOwnProvider(config.providers, provider)) {
        return jsonResponse({ error: "unknown provider" }, 404);
      }
      // Validate a supplied per-provider value before mutating anything: it must be a
      // finite number, and after flooring it must still be >= 1 — a value like 0.5 would
      // otherwise floor to 0 and silently fall back to the global default.
      if (body.value !== undefined && (typeof body.value !== "number" || !Number.isFinite(body.value))) {
        return jsonResponse({ error: "value must be a positive number" }, 400);
      }
      const perProviderValue = typeof body.value === "number" ? Math.floor(body.value) : undefined;
      if (perProviderValue !== undefined && perProviderValue < 1) {
        return jsonResponse({ error: "value must be a positive number" }, 400);
      }
      setProviderContextCap(config, provider, body.enabled, perProviderValue);
      save(config);
      reconcileLiveStateStores();
      clearModelCache(provider);
      const catalogRefresh = await convergeCodexCatalog();
      return respond(catalogRefresh);
    }

    // Branch 2: set the global cap value. When `setAll` accompanies it (dashboard "apply to
    // every routed provider" toggle), re-point every enabled provider; otherwise keep each
    // provider's own cap value and only change the default for future toggles.
    if (body.value !== undefined) {
      // Same normalization as the per-provider branch: floor before validating so a value
      // that floors to zero is rejected rather than silently stored.
      if (typeof body.value !== "number" || !Number.isFinite(body.value)) {
        return jsonResponse({ error: "value must be a positive number" }, 400);
      }
      const normalizedValue = Math.floor(body.value);
      if (normalizedValue < 1) {
        return jsonResponse({ error: "value must be a positive number" }, 400);
      }
      if (body.setAll !== undefined && typeof body.setAll !== "boolean") {
        return jsonResponse({ error: "setAll must be a boolean" }, 400);
      }
      const affected = Object.keys(providerContextCaps(config));
      const applyToAll = body.setAll === true;
      setGlobalContextCapValue(config, normalizedValue, applyToAll);
      save(config);
      reconcileLiveStateStores();
      if (applyToAll) {
        for (const provider of affected) clearModelCache(provider);
      }
      const catalogRefresh = await convergeCodexCatalog();
      return respond(catalogRefresh);
    }

    // Branch 3: enable/clear the cap for every provider at once.
    if (body.setAll !== undefined) {
      if (typeof body.setAll !== "boolean") {
        return jsonResponse({ error: "setAll must be a boolean" }, 400);
      }
      const before = Object.keys(providerContextCaps(config));
      const names = Object.keys(config.providers);
      setAllProviderContextCaps(config, names, body.setAll);
      save(config);
      reconcileLiveStateStores();
      for (const provider of new Set([...before, ...names])) clearModelCache(provider);
      const catalogRefresh = await convergeCodexCatalog();
      return respond(catalogRefresh);
    }

    // Unrecognized payload: reject rather than silently succeeding.
    return jsonResponse({ error: "provider string and enabled boolean are required" }, 400);
  }

  // Complete GUI picker presets, derived from the canonical provider registry. The GUI is a
  // standalone Vite package, so it consumes this runtime view instead of importing repo-root src.
  if (url.pathname === "/api/provider-presets" && req.method === "GET") {
    return jsonResponse({ providers: deriveProviderPresets() });
  }
  return null;
}
