import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Codex parses a catalog entry's `input_modalities` as a closed enum, and one out-of-enum
 * value makes it reject the ENTIRE catalog file — plugins, apps and MCP servers all stop
 * loading over one model's metadata (#759).
 *
 * The catalog writer normalizes on the way out, but a rejected value stored here would still
 * be handed back to the GUI and CLI as if it were real, and the offline `ocx models add` path
 * already refuses it. Validate at ingress so all three paths agree.
 */
const ALLOWED_INPUT_MODALITIES = new Set(["text", "image", "audio"]);
const CUSTOM_MODEL_CODEX_ACCOUNT_TARGET_WRITE_NONCE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readCustomModelAccountTargetWriteNonce(raw: unknown): { value?: string; error?: string } {
  if (raw === undefined) return {};
  return typeof raw === "string" && CUSTOM_MODEL_CODEX_ACCOUNT_TARGET_WRITE_NONCE_RE.test(raw)
    ? { value: raw }
    : { error: "codexAccountTargetWriteNonce must be a UUID" };
}

function readInputModalities(raw: unknown): { values?: string[]; error?: string } {
  if (raw === undefined) return {};
  if (!Array.isArray(raw)) return { error: "inputModalities must be an array" };
  // Reject non-strings rather than filtering them out. Dropping them silently accepted a
  // malformed POST and, worse, let a PUT of `[42]` clear the stored modalities while
  // answering 200 — the opposite of the contract this validator exists to state. An empty
  // array stays valid: that is how `ocx models edit --modalities -` clears the field.
  const rejected: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") return { error: "inputModalities must contain only strings" };
    if (!ALLOWED_INPUT_MODALITIES.has(value)) rejected.push(value);
  }
  if (rejected.length > 0) {
    return { error: `unsupported input modality: ${rejected.join(", ")} (allowed: text, image, audio)` };
  }
  return { values: raw as string[] };
}

/**
 * Custom-row reasoning ladder. Labels are validated against the Codex ladder (low..ultra)
 * exactly like provider `modelReasoningEfforts` values; unknown labels would otherwise
 * surface in a catalog the upstream never accepts. An empty array is meaningful (explicit
 * "no reasoning" hides the effort control) and must be preserved, not cleared.
 */
function readReasoningEfforts(raw: unknown): { values?: string[]; error?: string } {
  if (raw === undefined) return {};
  if (!Array.isArray(raw)) return { error: "reasoningEfforts must be an array" };
  const rejected: string[] = [];
  const values: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") return { error: "reasoningEfforts must contain only strings" };
    if (!isDeclaredReasoningEffort(value)) { rejected.push(value); continue; }
    if (!values.includes(value)) values.push(value);
  }
  if (rejected.length > 0) {
    return { error: `unsupported reasoning effort: ${rejected.join(", ")} (allowed: none, minimal, low, medium, high, xhigh, max, ultra)` };
  }
  // Canonical order: the catalog writes supported_reasoning_levels in input order and the
  // fallback default picks the first entry, so a caller-chosen order must not leak through.
  return { values: canonicalizeReasoningEfforts(values) };
}

/** Default effort must be a ladder member that the declared ladder actually includes. */
function readDefaultReasoningEffort(raw: unknown, efforts: string[] | undefined): { value?: string; error?: string } {
  if (raw === undefined) return {};
  if (raw === null) return { value: undefined };
  if (typeof raw !== "string" || !isDeclaredReasoningEffort(raw)) {
    return { error: "defaultReasoningEffort must be one of: none, minimal, low, medium, high, xhigh, max, ultra" };
  }
  if (efforts === undefined || efforts.length === 0) {
    return { error: "defaultReasoningEffort requires a non-empty reasoningEfforts ladder" };
  }
  if (!efforts.includes(raw)) {
    return { error: `defaultReasoningEffort "${raw}" is not in the declared reasoningEfforts ladder` };
  }
  return { value: raw };
}
import type { CatalogModel } from "../../codex/catalog";
import { accountBoundNativeOpenAiSlugsBySelector, catalogModelSlug, configuredNativeAliasSlugs, disabledNativeSlugs, invalidateCodexModelsCache, nativeModelRows, shouldIncludeAccountBoundNativeOpenAi, uniqueCatalogModelsForPublicList } from "../../codex/catalog";
import { CatalogGatherBusyError } from "../../codex/catalog/provider-fetch";
import { getProviderLiveModelCount } from "../../codex/model-cache";
import {
  DEFAULT_SUBAGENT_MODELS,
  adoptPersistedConfigSnapshotIntoLiveConfig,
  codexAutoStartEnabled,
  hasOwnProvider,
  isValidProviderName,
  multiAgentGuidanceEnabled,
  mutatePersistedConfigWithSnapshot,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  saveConfigPreservingClaudeCode,
  ConfigMutationLockError,
  type PersistedConfigMutation,
  type PersistedConfigSnapshotMutationOutcome,
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
import { removeCredential } from "../../oauth/store";
import { providerDestinationResolvedError } from "../../lib/destination-policy";
import { enrichProviderFromCatalog, listKeyLoginProviders } from "../../oauth/key-providers";
import { deriveProviderPresets } from "../../providers/derive";
import { providerCodexAccountMode } from "../../providers/registry";
import { encodedModelIdCollides, routedSlug, slugEquals } from "../../providers/slug-codec";
import { knownModelIdsForProvider } from "../../router";
import { COMBO_NAMESPACE, comboDisabledModelSelectors, comboModelId, preservesPhysicalComboProvider } from "../../combos";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../../providers/quota";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { clearThreadAccountMap } from "../../codex/routing";
import { primeCodexPoolQuotas } from "../../codex/auth-api";
import {
  customModelCodexAccountTargetAssignmentError,
  filterModelsByCustomRouteAvailability,
} from "../../codex/custom-model-account-target";
import { DEFAULT_PROVIDER_CONTEXT_CAP, globalContextCapValue, providerContextCap, providerContextCaps, setAllProviderContextCaps, setGlobalContextCapValue, setProviderContextCap } from "../../providers/context-cap";
import { resolveCodexHomeDir } from "../../codex/home";
import { readUsageEntries } from "../../usage/log";
import { getUsageDebugLogEntries } from "../../usage/debug";
import { parseRange, parseUsageSurface, summarizeUsage } from "../../usage/summary";
import { stripCodexRuntimeProviderFields } from "../../codex/auth-context";
import { getProviderRegistryEntry } from "../../providers/registry";
import { getDebugLogEntries } from "../../lib/debug-log-buffer";
import { canonicalizeReasoningEfforts, isDeclaredReasoningEffort } from "../../reasoning-effort";
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
import { isAllowedRequestOrigin, jsonResponse, providerManagementConfigError, publicProviderBaseUrl, safeConfigDTO, corsHeaders } from "../auth-cors";
import { applySystemEnvToggle } from "../system-env";
import {
  EXPORT_CLIENTS,
  EXPORT_CLIENT_IDS,
  OPENCODE_PROVIDER_ID,
  buildClientConfigText,
  isExportClientId,
  opencodeProxyBaseUrl,
} from "../../clients/config-export";
import type {
  ExportClientId,
  ExportModel,
  OpencodeGeneratedConfig,
  PiGeneratedConfig,
} from "../../clients/config-export";

import { isPlainRecord, parseDebugLogQuery, tokPerSecondResult, unavailableCostReason, costResult, requestLogDto, stripRegistryOnlyStaticHeaders, fetchAllModels } from "./shared";
import type { MetricUnavailableReason, TokPerSecondResult, CostEstimateReason, CostResult, MetricSource } from "./shared";
import type { ManagementContext } from "./context";
import { listManagementModelRows, loadExportModels } from "./model-rows";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";

type CustomModelPutBody = {
  displayName?: unknown;
  contextWindow?: unknown;
  inputModalities?: unknown;
  modelId?: unknown;
  reasoningEfforts?: unknown;
  defaultReasoningEffort?: unknown;
  codexAccountTarget?: unknown;
  codexAccountTargetWriteNonce?: unknown;
};

type CustomModelWriteResult =
  | { ok: true; row: OcxCustomModel; config: OcxConfig }
  | { ok: false; status: 400 | 404 | 409; error: string; config: OcxConfig };

function customModelWriteError(
  config: OcxConfig,
  status: 400 | 404 | 409,
  error: string,
): CustomModelWriteResult {
  return {
    ok: false,
    status,
    error,
    config: structuredClone(config),
  };
}

/** Build one PUT result without mutating the caller until every invariant passes. */
function buildCustomModelPutMutation(
  config: OcxConfig,
  id: string,
  body: CustomModelPutBody,
  targetAware: boolean,
): CustomModelWriteResult {
  const list = config.customModels ?? [];
  const idx = list.findIndex(model => model.id === id);
  if (idx === -1) return customModelWriteError(config, 404, "not found");
  const cm = { ...list[idx] };
  if (
    !targetAware
    && (
      Object.hasOwn(body, "codexAccountTarget")
      || Object.hasOwn(cm, "codexAccountTarget")
    )
  ) {
    return customModelWriteError(config, 409, "target-aware route required");
  }
  if (typeof body.modelId === "string" && body.modelId.trim()) {
    cm.modelId = body.modelId.trim();
  }
  if (body.displayName !== undefined) {
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (displayName.includes("/")) {
      return customModelWriteError(config, 400, "displayName must not contain /");
    }
    cm.displayName = displayName || undefined;
  }
  if (body.contextWindow !== undefined) {
    cm.contextWindow = typeof body.contextWindow === "number" && body.contextWindow > 0
      ? Math.floor(body.contextWindow)
      : undefined;
  }
  if (body.codexAccountTarget !== undefined) {
    if (body.codexAccountTarget === null) {
      delete cm.codexAccountTarget;
    } else {
      const targetError = customModelCodexAccountTargetAssignmentError(
        config,
        cm.provider,
        body.codexAccountTarget,
        cm.codexAccountTarget,
      );
      if (targetError) return customModelWriteError(config, 400, targetError);
      cm.codexAccountTarget = body.codexAccountTarget as string;
    }
  }
  if (body.inputModalities !== undefined) {
    const edited = readInputModalities(body.inputModalities);
    if (edited.error) return customModelWriteError(config, 400, edited.error);
    cm.inputModalities = edited.values && edited.values.length > 0 ? edited.values : undefined;
  }
  // `null` clears the stored ladder back to provider inheritance; `[]` remains an
  // explicit no-reasoning override.
  if (body.reasoningEfforts !== undefined) {
    if (body.reasoningEfforts === null) {
      cm.reasoningEfforts = undefined;
    } else {
      const edited = readReasoningEfforts(body.reasoningEfforts);
      if (edited.error) return customModelWriteError(config, 400, edited.error);
      cm.reasoningEfforts = edited.values;
    }
  }
  if (body.defaultReasoningEffort !== undefined) {
    const edited = readDefaultReasoningEffort(body.defaultReasoningEffort, cm.reasoningEfforts);
    if (edited.error) return customModelWriteError(config, 400, edited.error);
    cm.defaultReasoningEffort = edited.value;
  }
  if (cm.defaultReasoningEffort !== undefined) {
    const ladder = cm.reasoningEfforts;
    if (!ladder || ladder.length === 0 || !ladder.includes(cm.defaultReasoningEffort)) {
      cm.defaultReasoningEffort = undefined;
    }
  }
  const updatedSlug = routedSlug(cm.provider, cm.modelId);
  if (list.some((other, index) => index !== idx && routedSlug(other.provider, other.modelId) === updatedSlug)) {
    return customModelWriteError(config, 409, "duplicate model");
  }
  const known = knownModelIdsForProvider(cm.provider, config.providers[cm.provider], {
    ...config,
    customModels: list.filter((_, index) => index !== idx),
  });
  if (encodedModelIdCollides(cm.modelId, known)) {
    return customModelWriteError(config, 409, "ambiguous model id");
  }
  const targetAwareWrite = Object.hasOwn(body, "codexAccountTarget")
    || Object.hasOwn(cm, "codexAccountTarget");
  if (targetAware && !targetAwareWrite) {
    return customModelWriteError(config, 400, "target-aware custom model write has no account binding");
  }
  const customModels = list.map((model, index) => index === idx ? cm : model);
  const nextConfig = structuredClone(config);
  nextConfig.customModels = structuredClone(customModels);
  return { ok: true, row: cm, config: nextConfig };
}

/**
 * Counts read back off the SERIALIZED document rather than recomputed from the input rows.
 * `modelsWithoutLimits` drives a GUI line claiming "these models ship without limits", so it
 * has to describe the bytes the user actually receives — a parallel reimplementation of the
 * core's "authoritative context window" rule would be free to drift from it silently.
 */
function summarizeExportedModels(client: ExportClientId, document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  // Each client counts its own document shape. The previous branch assumed
  // "anything that is not OpenCode must be Pi", which silently misread the
  // moment a third client existed.
  return EXPORT_CLIENTS[client].summarize(document);
}

export async function handleModelRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps, convergeCodexCatalog, syncClaudeAgentDefsBestEffort } = ctx;
  // A handler persists the exact config object passed in. Production defaults to
  // the real store; tests that pass an in-memory fixture inject a no-op/spy. Do not
  // bypass this seam with a dynamic config import — doing so replaced a user's
  // ~/.opencodex/config.json with the `existing-uuid` test fixture.
  const persistConfig = deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode;
  const mutateFixtureConfig = <T>(
    mutate: (candidate: OcxConfig) => PersistedConfigMutation<T>,
  ): PersistedConfigSnapshotMutationOutcome<T> => {
    const candidate = structuredClone(config);
    const mutation = mutate(candidate);
    if (mutation.changed) persistConfig(candidate);
    return {
      status: mutation.changed ? "committed" : "unchanged",
      value: mutation.value,
      config: structuredClone(mutation.changed ? candidate : config),
    };
  };
  const mutateConfig: typeof mutatePersistedConfigWithSnapshot = deps.mutatePersistedConfig
    ?? (deps.saveConfigPreservingClaudeCode ? mutateFixtureConfig : mutatePersistedConfigWithSnapshot);

  if (url.pathname === "/api/catalog" && req.method === "GET") {
    const { readCatalog, readCodexCatalogPath } = await import("../../codex/catalog");
    const catalog = readCatalog(readCodexCatalogPath());
    if (!catalog) return jsonResponse({ error: "catalog not found" }, 404, req, config);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...corsHeaders(req, config),
    };
    const { loadPersistedCodexRuntime } = await import("../../codex/runtime");
    const version = loadPersistedCodexRuntime()?.selectedVersion;
    if (version) headers["x-opencodex-codex-version"] = version;
    return new Response(JSON.stringify(catalog), { status: 200, headers });
  }

  if (url.pathname === "/api/models" && req.method === "GET") {
    return jsonResponse(await listManagementModelRows(config));
  }

  /**
   * Client config document for OpenCode / Pi, built from the SAME function `ocx export`
   * calls, so the bytes a user downloads here and the bytes they pipe from the CLI cannot
   * disagree. Read-only: this route never writes the user's client config.
   */
  if (url.pathname === "/api/client-config" && req.method === "GET") {
    const requested = url.searchParams.get("client")?.trim() ?? "";
    if (!isExportClientId(requested)) {
      return jsonResponse(
        { error: `client must be one of: ${EXPORT_CLIENT_IDS.join(", ")}` },
        400,
        req,
        config,
      );
    }
    const spec = EXPORT_CLIENTS[requested];
    let models: ExportModel[];
    try {
      // The ONE loader every export surface uses. It carries the visibility
      // filter with it, so this route and the integration routes cannot end up
      // telling a client about different models.
      models = await loadExportModels(config);
    } catch (error) {
      // A partial or empty `models` block reads as a valid config while offering nothing,
      // so a catalog failure is surfaced as unavailable rather than serialized. The
      // catalog-busy error keeps its own 503 from handleManagementAPI.
      if (error instanceof CatalogGatherBusyError) throw error;
      return jsonResponse(
        { error: `model catalog unavailable: ${error instanceof Error ? error.message : String(error)}` },
        503,
        req,
        config,
      );
    }
    const built = buildClientConfigText(requested, {
      baseUrl: opencodeProxyBaseUrl(Number(url.port) || config.port, config.hostname),
      models,
      config,
    });
    const document = built.document;
    return jsonResponse({
      client: spec.id,
      filename: spec.filename,
      destination: spec.destination(process.env),
      apiKeyEnv: spec.apiKeyEnv,
      exportHint: spec.exportHint,
      // The client's own format and the exact bytes for it. The GUI previously
      // re-serialized `config` as JSON, which is wrong for four of the six
      // clients; `mediaType` also drives the download blob.
      format: built.format,
      mediaType: built.mediaType,
      text: built.text,
      ...summarizeExportedModels(requested, document),
      config: document,
    }, 200, req, config);
  }

  // Enable/disable models: which routed models Codex sees. PUT hides them from the catalog +
  // /v1/models and invalidates Codex's 5-min models cache so it applies on the next turn.
  if (url.pathname === "/api/disabled-models" && req.method === "PUT") {
    let body: { models?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    const disabled = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === "string") : [];
    config.disabledModels = disabled;
    persistConfig(config);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ ok: true, disabled, catalogRefresh });
  }

  // One user-facing visibility switch spans two persisted filters: a provider allowlist and the
  // shared blocklist. Keep the update atomic so an interrupted request cannot expose a half-applied
  // state. Native rows only use the blocklist; routed/custom rows also join a non-empty allowlist.
  if (url.pathname === "/api/model-visibility" && req.method === "PUT") {
    let parsedBody: unknown;
    try { parsedBody = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(parsedBody)) return jsonResponse({ error: "invalid model visibility request" }, 400);
    const body = parsedBody;
    const scope = body.scope === "models" || body.scope === "provider" ? body.scope : null;
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    if (!scope || !provider || !isValidProviderName(provider) || typeof body.enabled !== "boolean" || !Array.isArray(body.targets)) {
      return jsonResponse({ error: "invalid model visibility request" }, 400);
    }

    const providerConfig = hasOwnProvider(config.providers, provider) ? config.providers[provider] : undefined;
    const isVirtualComboNamespace = provider === COMBO_NAMESPACE && !preservesPhysicalComboProvider(config);
    if (!providerConfig && provider !== "openai" && !isVirtualComboNamespace) {
      return jsonResponse({ error: "unknown model visibility provider" }, 400);
    }
    const accountNativeQualified = shouldIncludeAccountBoundNativeOpenAi(config)
      ? [...accountBoundNativeOpenAiSlugsBySelector(config).entries()].flatMap(([selector, slugs]) =>
        slugs.filter(slug => !nativeModelRows(config).some(row => row.slug === slug)).map(slug => `${selector}/${slug}`))
      : [];
    const supportedNative = new Set([
      ...nativeModelRows(config).map(row => row.slug),
      ...accountNativeQualified,
    ]);
    const targets: Array<{ id: string; native: boolean }> = [];
    const seen = new Set<string>();
    for (const value of body.targets) {
      if (!isPlainRecord(value) || typeof value.id !== "string" || (value.native !== undefined && typeof value.native !== "boolean")) {
        return jsonResponse({ error: "invalid model visibility target" }, 400);
      }
      const id = value.id.trim();
      const native = value.native === true;
      if (!id || (provider === "openai") !== native || (native && !supportedNative.has(id))) {
        return jsonResponse({ error: "invalid model visibility target" }, 400);
      }
      const key = `${native ? "native" : "routed"}:${id}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push({ id, native });
      }
    }
    if (targets.length === 0) return jsonResponse({ error: "model visibility targets required" }, 400);

    const knownComboSelectors = new Set(
      Object.entries(config.combos ?? {}).flatMap(([id, combo]) => (
        comboDisabledModelSelectors(id, combo)
      )),
    );
    const targetComboSelectors = new Map<string, Set<string>>();
    if (isVirtualComboNamespace) {
      for (const target of targets) {
        const combo = config.combos && Object.hasOwn(config.combos, target.id) ? config.combos[target.id] : undefined;
        if (!combo) return jsonResponse({ error: "invalid model visibility target" }, 400);
        targetComboSelectors.set(target.id, new Set(comboDisabledModelSelectors(target.id, combo)));
      }
    }
    const matchesTarget = (stored: string, target: { id: string; native: boolean }) => target.native
      ? stored === target.id
      : isVirtualComboNamespace
        ? targetComboSelectors.get(target.id)!.has(stored)
        : slugEquals(stored, provider, target.id);

    let disabled = [...new Set(config.disabledModels ?? [])];
    if (body.enabled) {
      if (scope === "provider") {
        if (providerConfig && !isVirtualComboNamespace) delete providerConfig.selectedModels;
        if (isVirtualComboNamespace) {
          disabled = disabled.filter(stored => !knownComboSelectors.has(stored));
        } else {
          const nativeIds = provider === "openai"
            ? disabledNativeSlugs({ disabledModels: disabled })
            : new Set<string>();
          const accountNativeIds = provider === "openai" ? new Set(accountNativeQualified) : new Set<string>();
          const nativeAliasSlugs = provider === "openai"
            ? configuredNativeAliasSlugs(config)
            : new Set<string>();
          disabled = disabled.filter(stored => (
            knownComboSelectors.has(stored)
            || nativeAliasSlugs.has(stored)
            || (!stored.startsWith(`${provider}/`) && !nativeIds.has(stored) && !accountNativeIds.has(stored))
          ));
        }
      } else {
        if (!isVirtualComboNamespace && providerConfig?.selectedModels && providerConfig.selectedModels.length > 0) {
          const additions = targets.filter(target => !target.native).map(target => target.id);
          providerConfig.selectedModels = [...new Set([...providerConfig.selectedModels, ...additions])];
        }
        disabled = disabled.filter(stored => !targets.some(target => matchesTarget(stored, target)));
      }
    } else {
      for (const target of targets) {
        const canonical = target.native
          ? target.id
          : isVirtualComboNamespace
            ? comboModelId(target.id)
            : routedSlug(provider, target.id);
        const alreadyDisabled = disabled.some(stored => matchesTarget(stored, target));
        if (!alreadyDisabled) disabled.push(canonical);
      }
    }

    config.disabledModels = disabled;
    persistConfig(config);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ ok: true, scope, provider, enabled: body.enabled, disabled, catalogRefresh });
  }

  if (url.pathname === "/api/custom-models" && req.method === "GET") {
    return jsonResponse(config.customModels ?? []);
  }

  const targetAwareCustomPost = url.pathname === "/api/custom-models/account-target";
  if ((url.pathname === "/api/custom-models" || targetAwareCustomPost) && req.method === "POST") {
    let body: { provider?: unknown; modelId?: unknown; displayName?: unknown; contextWindow?: unknown; inputModalities?: unknown; reasoningEfforts?: unknown; defaultReasoningEffort?: unknown; codexAccountTarget?: unknown; codexAccountTargetWriteNonce?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (
      !targetAwareCustomPost
      && (Object.hasOwn(body, "codexAccountTarget") || Object.hasOwn(body, "codexAccountTargetWriteNonce"))
    ) {
      return jsonResponse({ error: "target-aware route required" }, 409);
    }
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    if (!provider || !modelId) return jsonResponse({ error: "provider and modelId are required" }, 400);
    if (!isValidProviderName(provider)) return jsonResponse({ error: "invalid provider name" }, 400);
    const displayName = typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : undefined;
    if (displayName?.includes("/")) return jsonResponse({ error: "displayName must not contain /" }, 400);
    const contextWindow = typeof body.contextWindow === "number" && body.contextWindow > 0 ? Math.floor(body.contextWindow) : undefined;
    const modalities = readInputModalities(body.inputModalities);
    if (modalities.error) return jsonResponse({ error: modalities.error }, 400);
    const inputModalities = modalities.values;
    const reasoning = readReasoningEfforts(body.reasoningEfforts);
    if (reasoning.error) return jsonResponse({ error: reasoning.error }, 400);
    const defaultEffort = readDefaultReasoningEffort(body.defaultReasoningEffort, reasoning.values);
    if (defaultEffort.error) return jsonResponse({ error: defaultEffort.error }, 400);
    const accountTargetWriteNonce = readCustomModelAccountTargetWriteNonce(body.codexAccountTargetWriteNonce);
    if (accountTargetWriteNonce.error) return jsonResponse({ error: accountTargetWriteNonce.error }, 400);
    if (targetAwareCustomPost && (typeof body.codexAccountTarget !== "string" || !accountTargetWriteNonce.value)) {
      return jsonResponse({ error: "target-aware custom model writes require codexAccountTarget and a write nonce" }, 400);
    }
    const entry: OcxCustomModel = {
      id: randomUUID(),
      provider,
      modelId,
      ...(displayName ? { displayName } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(inputModalities && inputModalities.length > 0 ? { inputModalities } : {}),
      ...(reasoning.values !== undefined ? { reasoningEfforts: reasoning.values } : {}),
      ...(defaultEffort.value ? { defaultReasoningEffort: defaultEffort.value } : {}),
      ...(typeof body.codexAccountTarget === "string"
        ? { codexAccountTarget: body.codexAccountTarget }
        : {}),
      addedAt: new Date().toISOString(),
    };

    if (targetAwareCustomPost) {
      let mutation: PersistedConfigSnapshotMutationOutcome<CustomModelWriteResult>;
      try {
        mutation = mutateConfig<CustomModelWriteResult>(persisted => {
          if (!hasOwnProvider(persisted.providers, provider)) {
            return { changed: false, value: customModelWriteError(persisted, 404, "provider not configured") };
          }
          const targetError = customModelCodexAccountTargetAssignmentError(
            persisted,
            provider,
            body.codexAccountTarget,
          );
          if (targetError) {
            return { changed: false, value: customModelWriteError(persisted, 400, targetError) };
          }
          const existing = persisted.customModels ?? [];
          const newSlug = routedSlug(provider, modelId);
          if (existing.some(model => routedSlug(model.provider, model.modelId) === newSlug)) {
            return { changed: false, value: customModelWriteError(persisted, 409, "duplicate model") };
          }
          const known = knownModelIdsForProvider(provider, persisted.providers[provider], persisted);
          if (encodedModelIdCollides(modelId, known)) {
            return { changed: false, value: customModelWriteError(persisted, 409, "ambiguous model id") };
          }
          const customModels = [...existing, entry];
          persisted.customModels = customModels;
          return {
            changed: true,
            value: { ok: true, row: entry, config: structuredClone(persisted) },
          };
        });
      } catch (error) {
        if (error instanceof ConfigMutationLockError) {
          return jsonResponse({ error: "config could not be updated safely (conflict)" }, 409);
        }
        throw error;
      }
      if (mutation.status === "unavailable") {
        return jsonResponse({ error: `config could not be updated safely (${mutation.reason})` }, 409);
      }
      adoptPersistedConfigSnapshotIntoLiveConfig(config, mutation.config);
      if (!mutation.value.ok) {
        return jsonResponse({ error: mutation.value.error }, mutation.value.status);
      }
      const catalogRefresh = await convergeCodexCatalog();
      return jsonResponse({
        ...mutation.value.row,
        codexAccountTargetWriteNonce: accountTargetWriteNonce.value,
        catalogRefresh,
      }, 201);
    }

    if (!hasOwnProvider(config.providers, provider)) return jsonResponse({ error: "provider not configured" }, 404);
    const existing = config.customModels ?? [];
    const newSlug = routedSlug(provider, modelId);
    if (existing.some(cm => routedSlug(cm.provider, cm.modelId) === newSlug)) {
      return jsonResponse({ error: "duplicate model" }, 409);
    }
    const known = knownModelIdsForProvider(provider, config.providers[provider], config);
    if (encodedModelIdCollides(modelId, known)) {
      return jsonResponse({ error: "ambiguous model id" }, 409);
    }
    config.customModels = [...existing, entry];
    persistConfig(config);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({
      ...entry,
      catalogRefresh,
    }, 201);
  }

  const targetAwareCustomPutMatch = url.pathname.match(/^\/api\/custom-models\/([^/]+)\/account-target$/);
  const customPutMatch = targetAwareCustomPutMatch
    ?? url.pathname.match(/^\/api\/custom-models\/([^/]+)$/);
  if (customPutMatch && req.method === "PUT") {
    let id: string;
    try { id = decodeURIComponent(customPutMatch[1]); } catch { return jsonResponse({ error: "invalid id encoding" }, 400); }
    let body: CustomModelPutBody;
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (targetAwareCustomPutMatch) {
      const accountTargetWriteNonce = readCustomModelAccountTargetWriteNonce(body.codexAccountTargetWriteNonce);
      if (accountTargetWriteNonce.error) return jsonResponse({ error: accountTargetWriteNonce.error }, 400);
      if (!accountTargetWriteNonce.value) {
        return jsonResponse({ error: "target-aware custom model writes require a write nonce" }, 400);
      }
      let mutation: PersistedConfigSnapshotMutationOutcome<CustomModelWriteResult>;
      try {
        mutation = mutateConfig<CustomModelWriteResult>(persisted => {
          const result = buildCustomModelPutMutation(persisted, id, body, true);
          if (!result.ok) return { changed: false, value: result };
          const target = persisted as unknown as Record<string, unknown>;
          for (const key of Object.keys(target)) delete target[key];
          Object.assign(target, structuredClone(result.config) as unknown as Record<string, unknown>);
          return { changed: true, value: result };
        });
      } catch (error) {
        if (error instanceof ConfigMutationLockError) {
          return jsonResponse({ error: "config could not be updated safely (conflict)" }, 409);
        }
        throw error;
      }
      if (mutation.status === "unavailable") {
        return jsonResponse({ error: `config could not be updated safely (${mutation.reason})` }, 409);
      }
      adoptPersistedConfigSnapshotIntoLiveConfig(config, mutation.config);
      if (!mutation.value.ok) {
        return jsonResponse({ error: mutation.value.error }, mutation.value.status);
      }
      const catalogRefresh = await convergeCodexCatalog();
      return jsonResponse({
        ...mutation.value.row,
        codexAccountTargetWriteNonce: accountTargetWriteNonce.value,
        catalogRefresh,
      });
    }

    const result = buildCustomModelPutMutation(config, id, body, false);
    if (!result.ok) return jsonResponse({ error: result.error }, result.status);
    config.customModels = structuredClone(result.config.customModels ?? []);
    persistConfig(config);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ ...result.row, catalogRefresh });
  }

  const customDelMatch = url.pathname.match(/^\/api\/custom-models\/([^/]+)$/);
  if (customDelMatch && req.method === "DELETE") {
    let id: string;
    try { id = decodeURIComponent(customDelMatch[1]); } catch { return jsonResponse({ error: "invalid id encoding" }, 400); }
    const list = config.customModels ?? [];
    const idx = list.findIndex(cm => cm.id === id);
    if (idx === -1) return jsonResponse({ error: "not found" }, 404);
    list.splice(idx, 1);
    config.customModels = list.length > 0 ? list : undefined;
    persistConfig(config);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ ok: true, catalogRefresh });
  }

  // Per-provider catalog allowlist (issue #52): when a provider has a non-empty selectedModels list,
  // only those ids ship to Codex's catalog / /v1/models. GET returns the CURRENT selection plus the
  // FULL editable set per provider: disabled and currently-unselected rows remain available, while
  // an exact-account row whose target is unavailable stays repair-only in `/api/models`.
  if (url.pathname === "/api/selected-models" && req.method === "GET") {
    const models = filterModelsByCustomRouteAvailability(
      await (deps.fetchAllModels ?? fetchAllModels)(config),
      config,
    );
    const available: Record<string, string[]> = {};
    for (const m of models) (available[m.provider] ??= []).push(m.id);
    const selected: Record<string, string[]> = {};
    // Live-catalog provenance. The GUI cannot infer this by subtracting known custom ids: an id
    // that is both custom and discovered would make a real live catalog look custom-only.
    const liveModelCounts: Record<string, number> = {};
    for (const [name, prov] of Object.entries(config.providers)) {
      if (Array.isArray(prov.selectedModels) && prov.selectedModels.length > 0) selected[name] = [...prov.selectedModels];
      const liveCount = getProviderLiveModelCount(name);
      if (liveCount !== undefined) liveModelCounts[name] = liveCount;
    }
    return jsonResponse({ selected, available, liveModelCounts });
  }
  if (url.pathname === "/api/selected-models" && req.method === "PUT") {
    let body: { provider?: unknown; models?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    const provider = typeof body.provider === "string" ? body.provider : "";
    if (!provider || !hasOwnProvider(config.providers, provider)) {
      return jsonResponse({ error: "unknown provider" }, provider ? 404 : 400);
    }
    const models = Array.isArray(body.models)
      ? [...new Set(body.models.filter((m): m is string => typeof m === "string"))]
      : [];
    // Empty list clears the allowlist (provider reverts to exposing all models).
    if (models.length > 0) config.providers[provider].selectedModels = models;
    else delete config.providers[provider].selectedModels;
    persistConfig(config);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ ok: true, provider, selected: models, catalogRefresh });
  }
  return null;
}
