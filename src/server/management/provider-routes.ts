import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CatalogModel } from "../../codex/catalog";
import { catalogModelSlug, invalidateCodexModelsCache, nativeModelRows, uniqueCatalogModelsForPublicList } from "../../codex/catalog";
import { parseProviderModelsApiItems } from "../../codex/catalog/provider-fetch";
import {
  DEFAULT_SUBAGENT_MODELS,
  codexAutoStartEnabled,
  hasOwnProvider,
  isValidProviderName,
  multiAgentGuidanceEnabled,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  saveConfig,
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
import { deriveProviderPresets, providerConfigSeed } from "../../providers/derive";
import { providerCodexAccountMode } from "../../providers/registry";
import { routedSlug, slugEquals } from "../../providers/slug-codec";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../../providers/quota";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { clearThreadAccountMap } from "../../codex/routing";
import { primeCodexPoolQuotas } from "../../codex/auth-api";
import { getProviderDiscoveryStatus } from "../../codex/model-cache";
import { DEFAULT_PROVIDER_CONTEXT_CAP, globalContextCapValue, providerContextCap, providerContextCaps, setAllProviderContextCaps, setGlobalContextCapValue, setProviderContextCap } from "../../providers/context-cap";
import { resolveCodexHomeDir } from "../../codex/home";
import { scanStorage } from "../../storage/scanner";
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
import { isAllowedRequestOrigin, jsonResponse, providerManagementConfigError, publicProviderBaseUrl, safeConfigDTO } from "../auth-cors";
import { applySystemEnvToggle } from "../system-env";

import { isPlainRecord, parseDebugLogQuery, tokPerSecondResult, unavailableCostReason, costResult, requestLogDto, stripRegistryOnlyStaticHeaders, fetchAllModels } from "./shared";
import type { MetricUnavailableReason, TokPerSecondResult, CostEstimateReason, CostResult, MetricSource } from "./shared";
import type { ManagementContext } from "./context";

export async function handleProviderRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps, refreshCodexCatalogBestEffort, syncClaudeAgentDefsBestEffort } = ctx;

  if (url.pathname === "/api/provider-quotas" && req.method === "GET") {
    const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
    return jsonResponse(await fetchProviderQuotaReports(config, forceRefresh));
  }

  if (url.pathname === "/api/providers" && req.method === "GET") {
    return jsonResponse(Object.entries(config.providers).map(([name, p]) => ({
      name, adapter: p.adapter, baseUrl: publicProviderBaseUrl(p.baseUrl), defaultModel: p.defaultModel,
      hasApiKey: !!p.apiKey,
      allowPrivateNetwork: p.allowPrivateNetwork === true,
      liveModels: p.liveModels !== false,
      models: p.models ?? [],
      authMode: p.authMode,
      disabled: p.disabled === true,
      codexAccountMode: providerCodexAccountMode(name, p),
      discovery: p.liveModels === false ? undefined : getProviderDiscoveryStatus(name),
    })));
  }

  // Add (or overwrite) a single provider. Merges into the live in-memory config and
  // persists — existing providers' real keys are never round-tripped (unlike PUT /api/config,
  // which would re-save the masked keys from GET). Live routing picks it up immediately.
  if (url.pathname === "/api/providers" && req.method === "POST") {
    let body: { name?: unknown; provider?: unknown; setDefault?: boolean };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const providerError = providerManagementConfigError(name, body.provider);
    if (providerError) return jsonResponse({ error: providerError }, 400);
    const prov = body.provider ? stripCodexRuntimeProviderFields(body.provider as OcxProviderConfig) : undefined;
    if (!name || !prov?.adapter || !prov?.baseUrl) {
      return jsonResponse({ error: "name, provider.adapter and provider.baseUrl are required" }, 400);
    }
    if (!isValidProviderName(name)) {
      return jsonResponse({ error: "provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key" }, 400);
    }
    // Hostname destinations additionally get a DNS-resolved SSRF check at write time —
    // the sync check above only classifies literal IPs (review finding, PR #96).
    const resolvedError = await providerDestinationResolvedError(name, prov);
    if (resolvedError) return jsonResponse({ error: resolvedError }, 400);
    // Catalog providers (e.g. ollama-cloud) carry a models + vision/reasoning classification the GUI
    // doesn't send — merge it in so the sidecars are gated correctly.
    enrichProviderFromCatalog(name, prov);
    const { saveConfig: save } = await import("../../config");
    // Overwriting an existing provider must not drop its multi-key pool: carry it over, then
    // let the (possibly new) apiKey join the pool as the active entry.
    const existingPool = config.providers[name]?.apiKeyPool;
    if (existingPool && !prov.apiKeyPool) prov.apiKeyPool = existingPool;
    config.providers[name] = stripRegistryOnlyStaticHeaders(name, prov);
    if (body.setDefault) config.defaultProvider = name;
    save(config);
    if (prov.apiKey && prov.apiKeyPool) {
      const { addProviderApiKey } = await import("../../providers/api-keys");
      addProviderApiKey(config, name, prov.apiKey);
    }
    const { clearModelCache } = await import("../../codex/model-cache");
    clearModelCache(name);
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ success: true, name });
  }

  if (url.pathname === "/api/providers" && req.method === "PATCH") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    let rawBody: unknown;
    try { rawBody = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(rawBody)) return jsonResponse({ error: "provider patch body must be a plain object" }, 400);
    const keys = Object.keys(rawBody);
    const hasMode = Object.hasOwn(rawBody, "codexAccountMode");

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
      const { saveConfig: save } = await import("../../config");
      config.providers.openai = { ...provider, codexAccountMode: mode };
      save(config);
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

    // Field-mask editor: apply recognized fields onto a copy, then validate the MERGED
    // provider (canonical-seed guard covers openai; local-guard covers registry key providers).
    // API keys are never writable here — the api-keys endpoints own pool-integrated key writes.
    if (Object.hasOwn(rawBody, "apiKey")) {
      return jsonResponse({ error: "apiKey cannot be patched here; use the provider API-key endpoints" }, 400);
    }
    const next: OcxProviderConfig = { ...config.providers[name]! };
    let touched = false;

    if (Object.hasOwn(rawBody, "disabled")) {
      if (typeof rawBody.disabled !== "boolean") return jsonResponse({ error: "disabled must be a boolean" }, 400);
      if (rawBody.disabled && name === config.defaultProvider) {
        return jsonResponse({ error: "cannot disable the default provider; set another default first" }, 400);
      }
      next.disabled = rawBody.disabled;
      touched = true;
    }
    if (Object.hasOwn(rawBody, "adapter")) {
      if (typeof rawBody.adapter !== "string" || !rawBody.adapter.trim()) return jsonResponse({ error: "adapter must be a non-empty string" }, 400);
      next.adapter = rawBody.adapter.trim();
      touched = true;
    }
    if (Object.hasOwn(rawBody, "baseUrl")) {
      if (typeof rawBody.baseUrl !== "string" || !rawBody.baseUrl.trim()) return jsonResponse({ error: "baseUrl must be a non-empty string" }, 400);
      next.baseUrl = rawBody.baseUrl.trim();
      touched = true;
    }
    if (Object.hasOwn(rawBody, "defaultModel")) {
      if (typeof rawBody.defaultModel !== "string") return jsonResponse({ error: "defaultModel must be a string" }, 400);
      const dm = rawBody.defaultModel.trim();
      if (dm) next.defaultModel = dm;
      else delete next.defaultModel;
      touched = true;
    }
    if (Object.hasOwn(rawBody, "authMode")) {
      if (typeof rawBody.authMode !== "string") return jsonResponse({ error: "authMode must be a string" }, 400);
      const mode = rawBody.authMode.trim();
      if (mode === "key" || mode === "forward" || mode === "oauth" || mode === "local") {
        next.authMode = mode;
        touched = true;
      } else if (mode === "") {
        delete next.authMode;
        touched = true;
      } else {
        return jsonResponse({ error: "authMode must be key, forward, oauth, or local" }, 400);
      }
    }
   if (Object.hasOwn(rawBody, "note")) {
     if (typeof rawBody.note !== "string") return jsonResponse({ error: "note must be a string" }, 400);
     const note = rawBody.note.trim();
     if (note) next.note = note;
     else delete next.note;
     touched = true;
   }

   if (Object.hasOwn(rawBody, "allowPrivateNetwork")) {
     if (typeof rawBody.allowPrivateNetwork !== "boolean") return jsonResponse({ error: "allowPrivateNetwork must be a boolean" }, 400);
     next.allowPrivateNetwork = rawBody.allowPrivateNetwork;
     touched = true;
   }

   if (Object.hasOwn(rawBody, "liveModels")) {
     if (typeof rawBody.liveModels !== "boolean") return jsonResponse({ error: "liveModels must be a boolean" }, 400);
     next.liveModels = rawBody.liveModels;
     touched = true;
   }

    if (!touched) return jsonResponse({ error: "no recognized fields to update" }, 400);

    // A disabled-only toggle preserves the v2 fast lane: it changes routing eligibility,
    // not the provider shape, so the merged-shape validators (canonical-seed guard for
    // openai, destination/local checks) do not apply.
    const editorTouched = keys.some(key => key !== "disabled");
    if (editorTouched) {
      const providerError = providerManagementConfigError(name, next);
      if (providerError) return jsonResponse({ error: providerError }, 400);
      const resolvedError = await providerDestinationResolvedError(name, next);
      if (resolvedError) return jsonResponse({ error: resolvedError }, 400);
    }

    const { saveConfig: save } = await import("../../config");
    config.providers[name] = stripRegistryOnlyStaticHeaders(name, next);
    save(config);
    if (editorTouched) {
      const { clearModelCache } = await import("../../codex/model-cache");
      clearModelCache(name);
    }
    await refreshCodexCatalogBestEffort();
    return jsonResponse({
      success: true,
      name,
      disabled: config.providers[name]!.disabled === true,
      hasApiKey: !!config.providers[name]!.apiKey,
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
      return jsonResponse({ ok: false, latencyMs: 0, error: "static catalog only — upstream not verified" });
    }
    const { resolveModelsAuthToken, buildModelsRequest } = await import("../../oauth");
    const apiKey = await resolveModelsAuthToken(name, prov);
    if (prov.authMode === "oauth" && !apiKey) {
      return jsonResponse({ ok: false, latencyMs: 0, error: "static catalog only — upstream not verified (not logged in)" });
    }
    const { url: modelsUrl, headers } = buildModelsRequest(prov, apiKey, name);
    const started = Date.now();
    try {
      const res = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(8000) });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        return jsonResponse({ ok: false, latencyMs, error: `upstream /models returned ${res.status}` });
      }
      const json = await res.json().catch(() => null) as { data?: unknown; models?: unknown } | null;
      // OpenAI-style lists use { data: [...] }; Google's /v1beta/models (the other shape
      // buildModelsRequest can produce) returns { models: [...] }.
      const list = json && typeof json === "object" && !Array.isArray(json)
        ? (Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : undefined)
        : undefined;
      if (!Array.isArray(list)) {
        return jsonResponse({ ok: false, latencyMs, error: "upstream /models returned an unexpected shape" });
      }
      const models = list.length;
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
        error: err instanceof Error ? err.message : "Connection test failed",
      });
    }
  }

  if (url.pathname === "/api/providers" && req.method === "DELETE") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    if (name === config.defaultProvider) return jsonResponse({ error: "cannot delete the default provider; set another default first" }, 400);
    const dependentCombos = Object.entries(config.combos ?? {})
      .filter(([, combo]) => combo.targets.some(target => target.provider === name))
      .map(([id]) => id)
      .sort((a, b) => a.localeCompare(b));
    if (dependentCombos.length > 0) {
      return jsonResponse({
        error: `cannot delete provider "${name}" while combos depend on it`,
        combos: dependentCombos,
      }, 409);
    }
    const { saveConfig: save } = await import("../../config");
    delete config.providers[name];
    setProviderContextCap(config, name, false);
    save(config);
    const { clearModelCache: clearCache } = await import("../../codex/model-cache");
    clearCache(name);
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ success: true });
  }

  if (url.pathname === "/api/provider-context-caps" && req.method === "GET") {
    return jsonResponse({ cap: DEFAULT_PROVIDER_CONTEXT_CAP, value: globalContextCapValue(config), caps: providerContextCaps(config) });
  }

  if (url.pathname === "/api/provider-context-caps" && req.method === "PUT") {
    let body: { provider?: unknown; enabled?: unknown; value?: unknown; setAll?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const { saveConfig: save } = await import("../../config");
    const { clearModelCache } = await import("../../codex/model-cache");
    const respond = () => jsonResponse({ ok: true, cap: DEFAULT_PROVIDER_CONTEXT_CAP, value: globalContextCapValue(config), caps: providerContextCaps(config) });

    // Branch 1: set the global cap value and re-point every enabled provider to it.
    if (body.value !== undefined) {
      if (typeof body.value !== "number" || !Number.isFinite(body.value) || body.value <= 0) {
        return jsonResponse({ error: "value must be a positive number" }, 400);
      }
      const affected = Object.keys(providerContextCaps(config));
      setGlobalContextCapValue(config, body.value);
      save(config);
      for (const provider of affected) clearModelCache(provider);
      await refreshCodexCatalogBestEffort();
      return respond();
    }

    // Branch 2: enable/clear the cap for every provider at once.
    if (body.setAll !== undefined) {
      if (typeof body.setAll !== "boolean") {
        return jsonResponse({ error: "setAll must be a boolean" }, 400);
      }
      const before = Object.keys(providerContextCaps(config));
      const names = Object.keys(config.providers);
      setAllProviderContextCaps(config, names, body.setAll);
      save(config);
      for (const provider of new Set([...before, ...names])) clearModelCache(provider);
      await refreshCodexCatalogBestEffort();
      return respond();
    }

    // Branch 3: existing per-provider toggle (enable writes the current global value).
    if (typeof body.provider !== "string" || typeof body.enabled !== "boolean") {
      return jsonResponse({ error: "provider string and enabled boolean are required" }, 400);
    }
    const provider = body.provider.trim();
    if (!isValidProviderName(provider)) {
      return jsonResponse({ error: "provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key" }, 400);
    }
    if (!hasOwnProvider(config.providers, provider)) {
      return jsonResponse({ error: "unknown provider" }, 404);
    }
    setProviderContextCap(config, provider, body.enabled);
    save(config);
    clearModelCache(provider);
    await refreshCodexCatalogBestEffort();
    return respond();
  }

  // Complete GUI picker presets, derived from the canonical provider registry. The GUI is a
  // standalone Vite package, so it consumes this runtime view instead of importing repo-root src.
  if (url.pathname === "/api/provider-presets" && req.method === "GET") {
    return jsonResponse({ providers: deriveProviderPresets() });
  }

  if (url.pathname === "/api/provider-presets/discover" && req.method === "POST") {
    let body: { presetId?: unknown; provider?: unknown; freeOnly?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const presetId = typeof body.presetId === "string" ? body.presetId.trim() : "";
    if (!presetId || !isValidProviderName(presetId)) return jsonResponse({ error: "invalid presetId" }, 400);
    const entry = getProviderRegistryEntry(presetId);
    if (!entry) return jsonResponse({ error: "unknown provider preset" }, 404);
    if (body.freeOnly !== undefined && typeof body.freeOnly !== "boolean") return jsonResponse({ error: "freeOnly must be a boolean" }, 400);
    if (body.freeOnly === true && presetId !== "openrouter") return jsonResponse({ error: "freeOnly is only supported for OpenRouter" }, 400);
    if (entry.supportLevel === "reference") {
      return jsonResponse({ error: "reference-only provider presets cannot be connected automatically" }, 400);
    }
    const providerError = providerManagementConfigError(presetId, body.provider);
    if (providerError) return jsonResponse({ error: providerError }, 400);
    const supplied = stripCodexRuntimeProviderFields(body.provider as OcxProviderConfig);
    const suppliedBaseUrl = supplied.baseUrl?.trim();
    let matchesResolvedTemplate = false;
    if (suppliedBaseUrl && entry.baseUrl.includes("{")) {
      try {
        const marker = "opencodex-template-value";
        const templateUrl = new URL(entry.baseUrl.replace(/\{[^}]+\}/g, marker));
        const candidateUrl = new URL(suppliedBaseUrl);
        const escapedPath = templateUrl.pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pathPattern = new RegExp(`^${escapedPath.replaceAll(marker, "[A-Za-z0-9_-]+")}/?$`);
        matchesResolvedTemplate = candidateUrl.origin === templateUrl.origin
          && !candidateUrl.search
          && !candidateUrl.hash
          && pathPattern.test(candidateUrl.pathname);
      } catch {
        matchesResolvedTemplate = false;
      }
    }
    const normalizedSuppliedBaseUrl = suppliedBaseUrl?.replace(/\/+$/, "");
    const matchesOfficialChoice = !!normalizedSuppliedBaseUrl && !!entry.baseUrlChoices?.some(choice =>
      choice.baseUrl?.replace(/\/+$/, "") === normalizedSuppliedBaseUrl
    );
    const acceptsResolvedBaseUrl = entry.allowBaseUrlOverride === true || matchesResolvedTemplate || matchesOfficialChoice;
    if (suppliedBaseUrl && suppliedBaseUrl.replace(/\/+$/, "") !== entry.baseUrl.replace(/\/+$/, "") && !acceptsResolvedBaseUrl) {
      return jsonResponse({ error: "provider baseUrl does not match the trusted preset" }, 400);
    }
    const provider = {
      ...providerConfigSeed(entry),
      ...(suppliedBaseUrl ? { baseUrl: suppliedBaseUrl } : {}),
      ...(supplied.apiKey ? { apiKey: supplied.apiKey } : {}),
      ...(supplied.defaultModel ? { defaultModel: supplied.defaultModel } : {}),
      ...(supplied.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
      ...(supplied.project ? { project: supplied.project } : {}),
      ...(supplied.location ? { location: supplied.location } : {}),
    };
    const staticModels = (entry.models ?? []).map(id => ({
      id,
      ...(entry.modelContextWindows?.[id] ? { contextWindow: entry.modelContextWindows[id] } : {}),
    }));
    const fallbackModels = body.freeOnly === true
      ? staticModels.filter(model => model.id.endsWith(":free"))
      : staticModels;
    const destinationError = await providerDestinationResolvedError(presetId, provider);
    if (destinationError) return jsonResponse({ error: destinationError }, 400);
    if (entry.discovery === "static" || entry.discovery === "unsupported" || entry.liveModels === false) {
      return jsonResponse(fallbackModels.length
        ? { ok: true, models: fallbackModels, source: "static", latencyMs: 0 }
        : { ok: false, models: [], source: "static", latencyMs: 0, error: "No static model catalog is available for this preset" });
    }
    const { resolveModelsAuthToken, buildModelsRequest } = await import("../../oauth");
    const apiKey = await resolveModelsAuthToken(presetId, provider);
    const request = buildModelsRequest(provider, apiKey, presetId);
    const modelsDestinationError = await providerDestinationResolvedError(presetId, { baseUrl: request.url });
    if (modelsDestinationError) return jsonResponse({ error: modelsDestinationError }, 400);
    const started = Date.now();
    try {
      const response = await fetch(request.url, { headers: request.headers, redirect: "error", signal: AbortSignal.timeout(8000) });
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        const error = `upstream model discovery returned ${response.status}`;
        return jsonResponse(fallbackModels.length
          ? { ok: true, models: fallbackModels, source: "static", latencyMs, error }
          : { ok: false, models: [], source: "live", latencyMs, error });
      }
      const allowsModelsEnvelope = (entry.adapter === "google" && (entry.googleMode ?? "ai-studio") === "ai-studio")
        || new URL(request.url).pathname.replace(/\/+$/, "").endsWith("/api/tags");
      const rows = parseProviderModelsApiItems(await response.json().catch(() => null), allowsModelsEnvelope);
      if (!rows) {
        const error = "upstream model discovery returned an unexpected shape";
        return jsonResponse(fallbackModels.length
          ? { ok: true, models: fallbackModels, source: "static", latencyMs, error }
          : { ok: false, models: [], source: "live", latencyMs, error });
      }
      const uniqueRows = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        const current = uniqueRows.get(row.id);
        if (!current || (!current.context_length && row.context_length)) uniqueRows.set(row.id, row);
        if (uniqueRows.size >= 2000) break;
      }
      const filteredRows = body.freeOnly === true
        ? [...uniqueRows.values()].filter(row => {
          const prompt = Number(row.pricing?.prompt);
          const completion = Number(row.pricing?.completion);
          return row.pricing !== undefined
            && Number.isFinite(prompt) && prompt >= 0
            && Number.isFinite(completion) && completion >= 0
            && prompt === 0 && completion === 0;
        })
        : [...uniqueRows.values()];
      const models = filteredRows.map(row => ({
        id: row.id,
        ...(row.context_length ? { contextWindow: row.context_length } : {}),
      }));
      if (models.length === 0) {
        const error = body.freeOnly === true
          ? "OpenRouter currently reports no free models"
          : "upstream model discovery returned an empty catalog";
        return jsonResponse(fallbackModels.length
          ? { ok: true, models: fallbackModels, source: "static", latencyMs, error }
          : { ok: false, models: [], source: "live", latencyMs, error });
      }
      return jsonResponse({ ok: true, models, source: "live", latencyMs });
    } catch {
      const latencyMs = Date.now() - started;
      const error = "model discovery request failed";
      return jsonResponse(fallbackModels.length
        ? { ok: true, models: fallbackModels, source: "static", latencyMs, error }
        : { ok: false, models: [], source: "live", latencyMs, error });
    }
  }
  return null;
}
