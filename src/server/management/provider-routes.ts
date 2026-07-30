import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CatalogModel } from "../../codex/catalog";
import { catalogModelSlug, invalidateCodexModelsCache, nativeModelRows, uniqueCatalogModelsForPublicList } from "../../codex/catalog";
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
import { ProviderOutboundPolicyError, providerOutboundGet, providerRedirectError } from "../../lib/provider-outbound";
import { enrichProviderFromCatalog, listKeyLoginProviders } from "../../oauth/key-providers";
import { deriveProviderPresets } from "../../providers/derive";
import { providerCodexAccountMode } from "../../providers/registry";
import {
  extractModelEnvelopeRows,
  extractProviderModelItems,
  readBoundedDiscoveryJson,
  resolveProviderModelDiscovery,
} from "../../providers/model-discovery";
import { routedSlug, slugEquals } from "../../providers/slug-codec";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../../providers/quota";
import { CODEX_FORWARD_BASE_URL, isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { codexAccountNamespaceProviderCollisionError } from "../../codex/account-namespace-match";
import { clearThreadAccountMap } from "../../codex/routing";
import { primeCodexPoolQuotas } from "../../codex/auth-api";
import { getProviderDiscoveryStatus } from "../../codex/model-cache";
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
      apiKeyTransport: p.apiKeyTransport,
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
    // Catalog providers (e.g. ollama-cloud) carry a models + vision/reasoning classification the GUI
    // doesn't send — merge it in so the sidecars are gated correctly.
    enrichProviderFromCatalog(name, prov);
    const { saveConfigPreservingClaudeCode: save } = await import("../../config");
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
      const { saveConfigPreservingClaudeCode: save } = await import("../../config");
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
    if (Object.hasOwn(rawBody, "apiKeyTransport")) {
      const transport = rawBody.apiKeyTransport;
      if (transport === "x-api-key" || transport === "bearer") {
        next.apiKeyTransport = transport;
        touched = true;
      } else if (transport === "") {
        delete next.apiKeyTransport;
        touched = true;
      } else {
        return jsonResponse({ error: "apiKeyTransport must be x-api-key, bearer, or empty to clear" }, 400);
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

    // A disabled-only toggle preserves the v2 fast lane for non-openai providers: it changes
    // routing eligibility, not the provider shape. Re-enabling `openai` is different — a
    // malformed disabled row must not come back online unchanged, so canonicalize/reject
    // against the same built-in gate used by mode PATCH and POST.
    const editorTouched = keys.some(key => key !== "disabled");
    const enablingOpenAi = name === "openai"
      && Object.hasOwn(rawBody, "disabled")
      && rawBody.disabled === false
      && config.providers[name]?.disabled === true;
    if (editorTouched) {
      const providerError = providerManagementConfigError(name, next);
      if (providerError) return jsonResponse({ error: providerError }, 400);
      const resolvedError = await providerDestinationResolvedError(name, next);
      if (resolvedError) return jsonResponse({ error: resolvedError }, 400);
    } else if (enablingOpenAi) {
      if (!isCanonicalOpenAiForwardProvider(next)) {
        return jsonResponse({ error: "provider openai must be the canonical built-in provider" }, 400);
      }
      // Persist the byte-identical canonical URL so config.ts startup checks (case-sensitive)
      // accept the row after we fill mode. Equivalent hosts like CHATGPT.com/:443 normalize here.
      next.baseUrl = CODEX_FORWARD_BASE_URL;
      // Fill missing mode so a disabled canonical row becomes a complete live openai entry.
      if (next.codexAccountMode !== "pool" && next.codexAccountMode !== "direct") {
        next.codexAccountMode = "pool";
      }
      // Same DNS gate as POST: Clash fake-IP only. Never honor a persisted
      // allowPrivateNetwork on this path — it must not bypass the built-in guard.
      const resolvedError = await providerDestinationResolvedError(
        "openai",
        { baseUrl: CODEX_FORWARD_BASE_URL },
        { allowBenchmarkAddresses: true },
      );
      if (resolvedError) return jsonResponse({ error: resolvedError }, 400);
      if (next.disabled === false) delete next.disabled;
      // Canonical openai never uses private-network opt-in; drop a stale flag that
      // was ignored for the DNS probe so it cannot linger on the live row.
      delete next.allowPrivateNetwork;
    }

    const { saveConfigPreservingClaudeCode: save } = await import("../../config");
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
    const discovery = resolveProviderModelDiscovery(name, prov);
    const started = Date.now();
    try {
      const res = await providerOutboundGet(name, prov, modelsUrl, {
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
        return jsonResponse({ ok: false, latencyMs, error: `upstream /models returned ${res.status}` });
      }
      const bounded = await readBoundedDiscoveryJson(res, discovery.maxResponseBytes);
      if (!bounded.ok) {
        return jsonResponse({
          ok: false,
          latencyMs,
          error: bounded.reason === "response_too_large"
            ? `upstream /models exceeded the ${discovery.maxResponseBytes}-byte response limit`
            : "upstream /models returned invalid JSON",
        });
      }
      // OpenAI-style lists (and Together top-level arrays) use the same validation/dedupe/filter
      // as catalog discovery. Google's /v1beta/models uses `models[].name` and remains a
      // connectivity-only count because it is not an authoritative catalog source.
      const record = bounded.value !== null && typeof bounded.value === "object" && !Array.isArray(bounded.value)
        ? bounded.value as Record<string, unknown>
        : undefined;
      const extracted = Array.isArray(bounded.value) || Array.isArray(record?.data)
        ? extractProviderModelItems(bounded.value, discovery)
        : extractModelEnvelopeRows(bounded.value, discovery.maxModels, ["models"]);
      if (!extracted.ok) {
        return jsonResponse({
          ok: false,
          latencyMs,
          error: extracted.reason === "too_many_models"
            ? `upstream /models exceeded the ${discovery.maxModels}-row model limit`
            : "upstream /models returned an unexpected shape",
        });
      }
      const models = "items" in extracted ? extracted.items.length : extracted.rows.length;
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
    const { saveConfigPreservingClaudeCode: save } = await import("../../config");
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
    const { saveConfigPreservingClaudeCode: save } = await import("../../config");
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
  return null;
}
