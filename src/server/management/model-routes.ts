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
import type { CatalogModel } from "../../codex/catalog";
import { catalogModelSlug, disabledNativeSlugs, invalidateCodexModelsCache, nativeModelRows, uniqueCatalogModelsForPublicList } from "../../codex/catalog";
import { CatalogGatherBusyError } from "../../codex/catalog/provider-fetch";
import { getProviderLiveModelCount } from "../../codex/model-cache";
import {
  DEFAULT_SUBAGENT_MODELS,
  codexAutoStartEnabled,
  hasOwnProvider,
  isValidProviderName,
  multiAgentGuidanceEnabled,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  saveConfigPreservingClaudeCode,
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
import { routedSlug, slugEquals } from "../../providers/slug-codec";
import { COMBO_NAMESPACE, comboModelId, comboPublicModelId, preservesPhysicalComboProvider } from "../../combos";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../../providers/quota";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { clearThreadAccountMap } from "../../codex/routing";
import { primeCodexPoolQuotas } from "../../codex/auth-api";
import { DEFAULT_PROVIDER_CONTEXT_CAP, globalContextCapValue, providerContextCap, providerContextCaps, setAllProviderContextCaps, setGlobalContextCapValue, setProviderContextCap } from "../../providers/context-cap";
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
import { isAllowedRequestOrigin, jsonResponse, providerManagementConfigError, publicProviderBaseUrl, safeConfigDTO, corsHeaders } from "../auth-cors";
import { applySystemEnvToggle } from "../system-env";
import {
  EXPORT_CLIENTS,
  EXPORT_CLIENT_IDS,
  OPENCODE_PROVIDER_ID,
  buildClientConfig,
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
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";

/**
 * One row of the `/api/models` list. Routed rows spread a `CatalogModel`, so the shape is
 * that model plus the identity/visibility fields this boundary computes for every row
 * regardless of source. `disabled` is always present; the rest vary by row origin.
 */
type ManagementModelRow = Partial<CatalogModel> & {
  provider: string;
  id: string;
  namespaced: string;
  disabled: boolean;
  native?: boolean;
  custom?: boolean;
  customId?: string;
};

/**
 * The exact row list `/api/models` returns. Extracted so `/api/client-config` exports the
 * models the GUI's Models tab shows — including this function's `disabled` computation,
 * which the export core (src/clients/config-export.ts) deliberately does not perform.
 */
async function listManagementModelRows(config: OcxConfig): Promise<ManagementModelRow[]> {
  const models = await fetchAllModels(config);
  const disabled = new Set(config.disabledModels ?? []);
  // Native GPT passthrough rows lead (provider "openai", bare-slug namespaced ids): sourced
  // from the static supported set so a disabled model stays listed and re-enableable.
  const native: ManagementModelRow[] = nativeModelRows(config).map(row => ({
    provider: "openai",
    id: row.slug,
    namespaced: row.slug,
    disabled: row.disabled,
    native: true,
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
  }));
  const customModels: ManagementModelRow[] = (config.customModels ?? []).map(cm => {
    const namespaced = routedSlug(cm.provider, cm.modelId);
    return {
      provider: cm.provider,
      id: cm.modelId,
      namespaced,
      disabled: [...disabled].some(stored => slugEquals(stored, cm.provider, cm.modelId)),
      custom: true,
      customId: cm.id,
      displayName: cm.displayName,
      ...(cm.contextWindow ? { contextWindow: cm.contextWindow } : {}),
      ...(cm.inputModalities ? { inputModalities: cm.inputModalities } : {}),
    };
  });
  const publicModels = uniqueCatalogModelsForPublicList(models);
  const comboNamespaced = new Set(
    publicModels.filter(model => model.provider === "combo").map(catalogModelSlug),
  );
  const visibleCustomModels = customModels.filter(model => !comboNamespaced.has(model.namespaced));
  // Custom metadata wins when a physical live/static row resolves to the same Codex-facing
  // slug, while a combo keeps the same precedence it has in routing and /v1/models.
  const customNamespaced = new Set(visibleCustomModels.map(c => c.namespaced));
  const dedupedRouted = publicModels.map((m): ManagementModelRow | null => {
    // Codex-facing slug (one "/", slug-codec); disabledModels compares tolerate both forms.
    const namespaced = catalogModelSlug(m);
    if (m.provider !== "combo" && customNamespaced.has(namespaced)) return null;
    const contextCap = providerContextCap(config, m.provider);
    return {
      ...m,
      namespaced,
      disabled: [...disabled].some(stored => (
        stored === namespaced || slugEquals(stored, m.provider, m.id)
      )),
      ...(contextCap !== undefined ? { contextCap, contextCapped: m.contextCapped === true } : {}),
    };
  }).filter((row): row is ManagementModelRow => row !== null);
  return [...native, ...dedupedRouted, ...visibleCustomModels];
}

/** `/api/models` row → the narrower input the client-config serializers accept. */
function toExportModel(row: ManagementModelRow): ExportModel {
  return {
    namespaced: row.namespaced,
    provider: row.provider,
    id: row.id,
    ...(row.native ? { native: true } : {}),
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    ...(row.inputModalities ? { inputModalities: row.inputModalities } : {}),
  };
}

/**
 * Counts read back off the SERIALIZED document rather than recomputed from the input rows.
 * `modelsWithoutLimits` drives a GUI line claiming "these models ship without limits", so it
 * has to describe the bytes the user actually receives — a parallel reimplementation of the
 * core's "authoritative context window" rule would be free to drift from it silently.
 */
function summarizeExportedModels(client: ExportClientId, document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  if (client === "opencode") {
    const models = (document as OpencodeGeneratedConfig).provider[OPENCODE_PROVIDER_ID].models;
    const entries = Object.values(models);
    return { modelCount: entries.length, modelsWithoutLimits: entries.filter(entry => entry.limit === undefined).length };
  }
  const models = (document as PiGeneratedConfig).providers[OPENCODE_PROVIDER_ID].models;
  return { modelCount: models.length, modelsWithoutLimits: models.filter(entry => entry.contextWindow === undefined).length };
}

export async function handleModelRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps, refreshCodexCatalogBestEffort, syncClaudeAgentDefsBestEffort } = ctx;
  // A handler persists the exact config object passed in. Production defaults to
  // the real store; tests that pass an in-memory fixture inject a no-op/spy. Do not
  // bypass this seam with a dynamic config import — doing so replaced a user's
  // ~/.opencodex/config.json with the `existing-uuid` test fixture.
  const persistConfig = deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode;

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
    let rows: ManagementModelRow[];
    try {
      rows = await listManagementModelRows(config);
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
    // The export core does not filter visibility — it serializes what it is given. A model the
    // user disabled in the Models tab is absent from /v1/models, so exporting it would hand the
    // client a selector the proxy refuses to route.
    const models = rows.filter(row => !row.disabled).map(toExportModel);
    const document = buildClientConfig(requested, {
      baseUrl: opencodeProxyBaseUrl(Number(url.port) || config.port, config.hostname),
      models,
      config,
    });
    return jsonResponse({
      client: spec.id,
      filename: spec.filename,
      destination: spec.destination(process.env),
      apiKeyEnv: spec.apiKeyEnv,
      exportHint: spec.exportHint,
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
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ ok: true, disabled });
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
    const supportedNative = new Set(nativeModelRows(config).map(row => row.slug));
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
      Object.entries(config.combos ?? {}).flatMap(([id, combo]) => [
        comboModelId(id),
        comboPublicModelId(id, combo),
      ]),
    );
    const targetComboSelectors = new Map<string, Set<string>>();
    if (isVirtualComboNamespace) {
      for (const target of targets) {
        const combo = config.combos && Object.hasOwn(config.combos, target.id) ? config.combos[target.id] : undefined;
        if (!combo) return jsonResponse({ error: "invalid model visibility target" }, 400);
        targetComboSelectors.set(target.id, new Set([comboModelId(target.id), comboPublicModelId(target.id, combo)]));
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
          disabled = disabled.filter(stored => (
            knownComboSelectors.has(stored)
            || (!stored.startsWith(`${provider}/`) && !nativeIds.has(stored))
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
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ ok: true, scope, provider, enabled: body.enabled, disabled });
  }

  if (url.pathname === "/api/custom-models" && req.method === "GET") {
    return jsonResponse(config.customModels ?? []);
  }

  if (url.pathname === "/api/custom-models" && req.method === "POST") {
    let body: { provider?: unknown; modelId?: unknown; displayName?: unknown; contextWindow?: unknown; inputModalities?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    if (!provider || !modelId) return jsonResponse({ error: "provider and modelId are required" }, 400);
    if (modelId.includes("/")) return jsonResponse({ error: "modelId must not contain /" }, 400);
    if (!isValidProviderName(provider)) return jsonResponse({ error: "invalid provider name" }, 400);
    if (!hasOwnProvider(config.providers, provider)) return jsonResponse({ error: "provider not configured" }, 404);
    const displayName = typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : undefined;
    if (displayName?.includes("/")) return jsonResponse({ error: "displayName must not contain /" }, 400);
    const contextWindow = typeof body.contextWindow === "number" && body.contextWindow > 0 ? Math.floor(body.contextWindow) : undefined;
    const modalities = readInputModalities(body.inputModalities);
    if (modalities.error) return jsonResponse({ error: modalities.error }, 400);
    const inputModalities = modalities.values;
    const existing = config.customModels ?? [];
    const newSlug = routedSlug(provider, modelId);
    if (existing.some(cm => routedSlug(cm.provider, cm.modelId) === newSlug)) {
      return jsonResponse({ error: "duplicate model" }, 409);
    }
    const entry: OcxCustomModel = {
      id: randomUUID(),
      provider,
      modelId,
      ...(displayName ? { displayName } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(inputModalities && inputModalities.length > 0 ? { inputModalities } : {}),
      addedAt: new Date().toISOString(),
    };
    config.customModels = [...existing, entry];
    persistConfig(config);
    await refreshCodexCatalogBestEffort();
    return jsonResponse(entry, 201);
  }

  const customPutMatch = url.pathname.match(/^\/api\/custom-models\/([^/]+)$/);
  if (customPutMatch && req.method === "PUT") {
    let id: string;
    try { id = decodeURIComponent(customPutMatch[1]); } catch { return jsonResponse({ error: "invalid id encoding" }, 400); }
    let body: { displayName?: unknown; contextWindow?: unknown; inputModalities?: unknown; modelId?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    const list = config.customModels ?? [];
    const idx = list.findIndex(cm => cm.id === id);
    if (idx === -1) return jsonResponse({ error: "not found" }, 404);
    const cm = { ...list[idx] };
    if (typeof body.modelId === "string" && body.modelId.trim()) {
      if (body.modelId.includes("/")) return jsonResponse({ error: "modelId must not contain /" }, 400);
      cm.modelId = body.modelId.trim();
    }
    if (body.displayName !== undefined) {
      const dn = typeof body.displayName === "string" ? body.displayName.trim() : "";
      if (dn.includes("/")) return jsonResponse({ error: "displayName must not contain /" }, 400);
      cm.displayName = dn || undefined;
    }
    if (body.contextWindow !== undefined) {
      cm.contextWindow = typeof body.contextWindow === "number" && body.contextWindow > 0 ? Math.floor(body.contextWindow) : undefined;
    }
    if (body.inputModalities !== undefined) {
      const edited = readInputModalities(body.inputModalities);
      if (edited.error) return jsonResponse({ error: edited.error }, 400);
      cm.inputModalities = edited.values && edited.values.length > 0 ? edited.values : undefined;
    }
    const updatedSlug = routedSlug(cm.provider, cm.modelId);
    if (list.some((other, i) => i !== idx && routedSlug(other.provider, other.modelId) === updatedSlug)) {
      return jsonResponse({ error: "duplicate model" }, 409);
    }
    list[idx] = cm;
    config.customModels = list;
    persistConfig(config);
    await refreshCodexCatalogBestEffort();
    return jsonResponse(cm);
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
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ ok: true });
  }

  // Per-provider catalog allowlist (issue #52): when a provider has a non-empty selectedModels list,
  // only those ids ship to Codex's catalog / /v1/models. GET returns the CURRENT selection plus the
  // FULL available set per provider (unfiltered — the picker needs everything to choose from).
  if (url.pathname === "/api/selected-models" && req.method === "GET") {
    const models = await fetchAllModels(config);
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
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ ok: true, provider, selected: models });
  }
  return null;
}
