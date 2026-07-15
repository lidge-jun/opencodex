import { readFileSync } from "node:fs";
import type { CatalogModel } from "../codex/catalog";
import { invalidateCodexModelsCache, nativeModelRows } from "../codex/catalog";
import {
  DEFAULT_SUBAGENT_MODELS,
  codexAutoStartEnabled,
  hasOwnProvider,
  isValidProviderName,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  saveConfig,
} from "../config";
import {
  cancelLoginFlow,
  clearLoginState,
  getLoginStatus,
  isOAuthProvider,
  listOAuthProviders,
  startLoginFlow,
  submitManualLoginCode,
  upsertOAuthProvider,
} from "../oauth";
import { removeCredential } from "../oauth/store";
import { providerDestinationResolvedError } from "../lib/destination-policy";
import { enrichProviderFromCatalog, listKeyLoginProviders } from "../oauth/key-providers";
import { deriveProviderPresets } from "../providers/derive";
import { fetchProviderQuotaReports } from "../providers/quota";
import { DEFAULT_PROVIDER_CONTEXT_CAP, globalContextCapValue, providerContextCap, providerContextCaps, setAllProviderContextCaps, setGlobalContextCapValue, setProviderContextCap } from "../providers/context-cap";
import { readUsageEntries } from "../usage/log";
import { getUsageDebugLogEntries } from "../usage/debug";
import { parseRange, summarizeUsage } from "../usage/summary";
import { stripCodexRuntimeProviderFields } from "../codex/auth-context";
import { getProviderRegistryEntry } from "../providers/registry";
import { getDebugLogEntries } from "../lib/debug-log-buffer";
import { getInjectionDebugLogEntries } from "../lib/injection-debug-log";
import {
  clearDebugSettings,
  clearDebugSetting,
  getDebugSettings,
  setDebugSettings,
  type DebugFlag,
} from "../lib/debug-settings";
import type { OcxClaudeCodeConfig, OcxConfig, OcxProviderConfig } from "../types";
import { drainAndShutdown } from "./lifecycle";
import { filterRequestLogs, getRequestLogEntries } from "./request-log";
import { isAllowedRequestOrigin, jsonResponse, providerManagementConfigError, publicProviderBaseUrl, safeConfigDTO } from "./auth-cors";
import { applySystemEnvToggle } from "./system-env";

// Single source of truth = package.json (../ from src/), so /healthz + the GUI badge match the
// installed npm version instead of a stale hardcode.
export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
})();

export interface ManagementApiDeps {
  toggleCodexMultiAgentV2?: (enabled: boolean) => void;
  refreshCodexCatalog?: () => Promise<void>;
}

/** Narrow an unknown JSON value to a plain (non-array) object for strict request-body validation. */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseDebugLogQuery(url: URL): { after: number; limit: number } {
  const after = Number(url.searchParams.get("after") ?? url.searchParams.get("since") ?? "0");
  const limit = Number(url.searchParams.get("limit") ?? "500");
  return {
    after: Number.isFinite(after) && after > 0 ? after : 0,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 2000) : 500,
  };
}

export async function handleManagementAPI(req: Request, url: URL, config: OcxConfig, deps: ManagementApiDeps = {}): Promise<Response | null> {
  if (!isAllowedRequestOrigin(req, config)) {
    return jsonResponse({ error: "cross-origin request blocked" }, 403, req, config);
  }
  // Management bodies are small JSON (provider names, key ids, settings). Reject oversized
  // payloads before any handler buffers them — the data plane has its own decompression cap.
  if (req.method === "POST" || req.method === "PUT") {
    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) {
      return jsonResponse({ error: "request body too large" }, 413, req, config);
    }
  }
  async function refreshCodexCatalogBestEffort(): Promise<void> {
    if (deps.refreshCodexCatalog) return deps.refreshCodexCatalog();
    try {
      const { refreshCodexModelCatalog } = await import("../codex/refresh");
      await refreshCodexModelCatalog(config);
    } catch {
      /* catalog absent */
    }
  }

  async function syncClaudeAgentDefsBestEffort(): Promise<void> {
    try {
      const { injectClaudeAgentDefs } = await import("../claude/agents-inject");
      if (config.claudeCode?.enabled === false || config.claudeCode?.injectAgents === false) {
        injectClaudeAgentDefs(config, {});
        return;
      }
      try {
        const [models, { buildClaudeContextWindows }, { visibleNativeSlugs }] = await Promise.all([
          fetchAllModels(config),
          import("../claude/context-windows"),
          import("../codex/catalog"),
        ]);
        injectClaudeAgentDefs(config, buildClaudeContextWindows([...visibleNativeSlugs(config)], models));
      } catch {
        // Keep routes available through a provider-discovery blip. A later
        // launch-time sync restores any context markers missing from this pass.
        injectClaudeAgentDefs(config, {});
      }
    } catch { /* best-effort */ }
  }

  if (url.pathname === "/api/config" && req.method === "GET") {
    return jsonResponse(safeConfigDTO(config));
  }

  if (url.pathname === "/api/config" && req.method === "PUT") {
    return jsonResponse({ error: "Full config PUT is disabled. Use /api/providers POST for provider changes." }, 405);
  }

  if (url.pathname === "/api/settings" && req.method === "GET") {
    return jsonResponse({
      codexAutoStart: codexAutoStartEnabled(config),
      port: config.port,
      hostname: config.hostname ?? "127.0.0.1",
    });
  }

  if (url.pathname === "/api/settings" && req.method === "PUT") {
    let body: { codexAutoStart?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (typeof body.codexAutoStart !== "boolean") {
      return jsonResponse({ error: "codexAutoStart boolean is required" }, 400);
    }
    config.codexAutoStart = body.codexAutoStart;
    saveConfig(config);
    return jsonResponse({ ok: true, codexAutoStart: codexAutoStartEnabled(config) });
  }

  if (url.pathname === "/api/diagnostics/project-config" && req.method === "GET") {
    const { getCachedProjectConfigDiagnostics } = await import("../codex/project-config-warnings");
    const { warnings, grouped } = getCachedProjectConfigDiagnostics();
    return jsonResponse({ warnings, grouped });
  }

  if (url.pathname === "/api/sync" && req.method === "POST") {
    const { syncModelsToCodex } = await import("../codex/sync");
    const result = await syncModelsToCodex(undefined, config, null);
    return jsonResponse({
      ...result,
      staleAppServerHint: "If Codex App still shows an older model list, restart its long-lived app-server process after sync.",
    }, result.ok ? 200 : 500);
  }

  if (url.pathname === "/api/update/check" && req.method === "GET") {
    const { checkForUpdate, normalizeUpdateChannel } = await import("../update/job");
    const rawTag = url.searchParams.get("tag");
    if (rawTag && rawTag !== "latest" && rawTag !== "preview") {
      return jsonResponse({ error: "tag must be latest or preview" }, 400);
    }
    return jsonResponse(checkForUpdate(normalizeUpdateChannel(rawTag)));
  }

  if (url.pathname === "/api/update/run" && req.method === "POST") {
    const { normalizeUpdateChannel, startUpdateJob, UpdateJobError } = await import("../update/job");
    let body: { tag?: unknown; restart?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (body.tag !== undefined && body.tag !== "latest" && body.tag !== "preview") {
      return jsonResponse({ error: "tag must be latest or preview" }, 400);
    }
    if (body.restart !== undefined && typeof body.restart !== "boolean") {
      return jsonResponse({ error: "restart boolean is required" }, 400);
    }
    try {
      return jsonResponse({ ok: true, job: startUpdateJob(normalizeUpdateChannel(body.tag as string | undefined), body.restart !== false) });
    } catch (err) {
      if (err instanceof UpdateJobError) {
        return jsonResponse({ error: err.message, code: err.code }, err.status);
      }
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  if (url.pathname === "/api/update/status" && req.method === "GET") {
    const { readUpdateJob } = await import("../update/job");
    const job = readUpdateJob(url.searchParams.get("jobId"));
    if (!job) return jsonResponse({ error: "update job not found" }, 404);
    return jsonResponse({ ok: true, job });
  }

  if (url.pathname === "/api/sidecar-settings" && req.method === "GET") {
    const ws = config.webSearchSidecar ?? {};
    const vs = config.visionSidecar ?? {};
    return jsonResponse({
      webSearch: { model: ws.model ?? "gpt-5.6-luna", backend: ws.backend },
      vision: {
        model: vs.model ?? "gpt-5.6-luna",
        backend: vs.backend,
        maxDescriptionsPerTurn: vs.maxDescriptionsPerTurn,
      },
    });
  }

  if (url.pathname === "/api/sidecar-settings" && req.method === "PUT") {
    let raw: unknown;
    try { raw = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    // Strict shape (review F2): reject non-object bodies and non-object sections instead of throwing
    // on `null` or silently accepting arrays/strings as no-op updates.
    if (!isPlainRecord(raw)) return jsonResponse({ error: "body must be a JSON object" }, 400);
    if (raw.webSearch !== undefined && !isPlainRecord(raw.webSearch)) return jsonResponse({ error: "webSearch must be an object" }, 400);
    if (raw.vision !== undefined && !isPlainRecord(raw.vision)) return jsonResponse({ error: "vision must be an object" }, 400);
    const body = raw as {
      webSearch?: { model?: unknown; backend?: unknown; reasoning?: unknown };
      vision?: { model?: unknown; backend?: unknown; maxDescriptionsPerTurn?: unknown };
    };
    if (body.webSearch && body.webSearch.backend !== undefined && body.webSearch.backend !== null
      && body.webSearch.backend !== "openai" && body.webSearch.backend !== "anthropic") {
      return jsonResponse({ error: "webSearch.backend must be openai, anthropic, or null" }, 400);
    }
    if (body.vision && body.vision.backend !== undefined
      && body.vision.backend !== null && body.vision.backend !== "openai" && body.vision.backend !== "anthropic") {
      return jsonResponse({ error: "vision.backend must be openai, anthropic, or null" }, 400);
    }
    if (body.vision && body.vision.maxDescriptionsPerTurn !== undefined
      && (typeof body.vision.maxDescriptionsPerTurn !== "number"
        || !Number.isInteger(body.vision.maxDescriptionsPerTurn)
        || body.vision.maxDescriptionsPerTurn <= 0)) {
      return jsonResponse({ error: "vision.maxDescriptionsPerTurn must be a positive integer" }, 400);
    }
    if (body.webSearch) {
      config.webSearchSidecar = { ...config.webSearchSidecar };
      if (typeof body.webSearch.model === "string") {
        if (body.webSearch.model === "") delete config.webSearchSidecar.model;
        else config.webSearchSidecar.model = body.webSearch.model;
      }
      if (body.webSearch.backend === null) delete config.webSearchSidecar.backend;
      else if (body.webSearch.backend === "openai" || body.webSearch.backend === "anthropic") {
        config.webSearchSidecar.backend = body.webSearch.backend;
      }
      if (typeof body.webSearch.reasoning === "string") config.webSearchSidecar.reasoning = body.webSearch.reasoning;
    }
    if (body.vision) {
      config.visionSidecar = { ...config.visionSidecar };
      if (typeof body.vision.model === "string") {
        if (body.vision.model === "") delete config.visionSidecar.model;
        else config.visionSidecar.model = body.vision.model;
      }
      if (body.vision.backend === null) delete config.visionSidecar.backend;
      else if (body.vision.backend === "openai" || body.vision.backend === "anthropic") {
        config.visionSidecar.backend = body.vision.backend;
      }
      if (typeof body.vision.maxDescriptionsPerTurn === "number") {
        config.visionSidecar.maxDescriptionsPerTurn = body.vision.maxDescriptionsPerTurn;
      }
    }
    saveConfig(config);
    const ws = config.webSearchSidecar ?? {};
    const vs = config.visionSidecar ?? {};
    return jsonResponse({
      ok: true,
      webSearch: { model: ws.model ?? "gpt-5.6-luna", backend: ws.backend },
      vision: {
        model: vs.model ?? "gpt-5.6-luna",
        backend: vs.backend,
        maxDescriptionsPerTurn: vs.maxDescriptionsPerTurn,
      },
    });
  }

  if (url.pathname === "/api/shadow-call-settings" && req.method === "GET") {
    const sci = config.shadowCallIntercept ?? {};
    return jsonResponse({ enabled: sci.enabled === true, model: sci.model ?? "" });
  }

  if (url.pathname === "/api/shadow-call-settings" && req.method === "PUT") {
    let raw: unknown;
    try { raw = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(raw)) return jsonResponse({ error: "body must be a JSON object" }, 400);
    const body = raw as { enabled?: unknown; model?: unknown };
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return jsonResponse({ error: "enabled must be a boolean" }, 400);
    }
    if (body.model !== undefined && typeof body.model !== "string") {
      return jsonResponse({ error: "model must be a string" }, 400);
    }
    config.shadowCallIntercept = { ...config.shadowCallIntercept };
    if (typeof body.enabled === "boolean") config.shadowCallIntercept.enabled = body.enabled;
    if (typeof body.model === "string") {
      if (body.model === "") delete config.shadowCallIntercept.model;
      else config.shadowCallIntercept.model = body.model;
    }
    saveConfig(config);
    const sci = config.shadowCallIntercept;
    return jsonResponse({ ok: true, enabled: sci.enabled === true, model: sci.model ?? "" });
  }

  if (url.pathname === "/api/logs" && req.method === "GET") {
    return jsonResponse(filterRequestLogs(getRequestLogEntries(), url.searchParams));
  }

  if (url.pathname === "/api/debug" && req.method === "GET") {
    return jsonResponse(getDebugSettings());
  }

  if (url.pathname === "/api/debug/logs" && req.method === "GET") {
    const { after, limit } = parseDebugLogQuery(url);
    return jsonResponse(getDebugLogEntries({ after, limit }));
  }

  if (url.pathname === "/api/debug/usage-logs" && req.method === "GET") {
    const { after, limit } = parseDebugLogQuery(url);
    return jsonResponse(getUsageDebugLogEntries({ after, limit }));
  }

  if (url.pathname === "/api/claude/inbound-debug" && req.method === "GET") {
    const { getClaudeInboundDebugEntries } = await import("../claude/inbound-debug");
    const { isClaudeDebugEnabled } = await import("../lib/debug-settings");
    return jsonResponse({ enabled: isClaudeDebugEnabled(), entries: getClaudeInboundDebugEntries() });
  }

  if (url.pathname === "/api/debug/injection-logs" && req.method === "GET") {
    const { after, limit } = parseDebugLogQuery(url);
    return jsonResponse(getInjectionDebugLogEntries({ after, limit }));
  }

  if (url.pathname === "/api/debug" && req.method === "PUT") {
    let body: { debug?: unknown; usage?: unknown; injection?: unknown; claude?: unknown; reset?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (body.reset === true) return jsonResponse(clearDebugSettings());
    if (body.reset === "debug" || body.reset === "provider") return jsonResponse(clearDebugSetting("debug"));
    if (body.reset === "usage") return jsonResponse(clearDebugSetting("usage"));
    if (body.reset === "injection") return jsonResponse(clearDebugSetting("injection"));
    if (body.reset === "claude") return jsonResponse(clearDebugSetting("claude"));
    const partial: Partial<Record<DebugFlag, boolean>> = {};
    for (const key of ["debug", "usage", "injection", "claude"] as const) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== "boolean") return jsonResponse({ error: `${key} must be a boolean` }, 400);
      partial[key] = body[key];
    }
    if (Object.keys(partial).length === 0) {
      return jsonResponse({ error: "provide debug/usage/injection/claude booleans or reset:true" }, 400);
    }
    // Turning capture off should also flush already-captured entries (privacy contract).
    if (partial.claude === false) {
      const { clearClaudeInboundDebug } = await import("../claude/inbound-debug");
      clearClaudeInboundDebug();
    }
    return jsonResponse(setDebugSettings(partial));
  }

  if (url.pathname === "/api/usage" && req.method === "GET") {
    const range = parseRange(url.searchParams.get("range"));
    const now = Date.now();
    try {
      return jsonResponse(summarizeUsage(readUsageEntries(), range, now));
    } catch {
      return jsonResponse({
        range,
        since: null,
        generatedAt: now,
        summary: {
          requests: 0,
          measuredRequests: 0,
          reportedRequests: 0,
          unreportedRequests: 0,
          unsupportedRequests: 0,
          estimatedRequests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 0,
          coverageRatio: 0,
        },
        days: [],
        models: [],
        providers: [],
        error: "read_failed",
      });
    }
  }

  if (url.pathname === "/api/provider-quotas" && req.method === "GET") {
    const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
    return jsonResponse(await fetchProviderQuotaReports(config, forceRefresh));
  }

  if (url.pathname === "/api/providers" && req.method === "GET") {
    return jsonResponse(Object.entries(config.providers).map(([name, p]) => ({
      name, adapter: p.adapter, baseUrl: publicProviderBaseUrl(p.baseUrl), defaultModel: p.defaultModel,
      hasApiKey: !!p.apiKey,
      allowPrivateNetwork: p.allowPrivateNetwork === true,
      disabled: p.disabled === true,
    })));
  }

  // Add (or overwrite) a single provider. Merges into the live in-memory config and
  // persists — existing providers' real keys are never round-tripped (unlike PUT /api/config,
  // which would re-save the masked keys from GET). Live routing picks it up immediately.
  if (url.pathname === "/api/providers" && req.method === "POST") {
    let body: { name?: string; provider?: OcxProviderConfig; setDefault?: boolean };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const name = body.name?.trim();
    const prov = body.provider ? stripCodexRuntimeProviderFields(body.provider) : undefined;
    if (!name || !prov?.adapter || !prov?.baseUrl) {
      return jsonResponse({ error: "name, provider.adapter and provider.baseUrl are required" }, 400);
    }
    if (!isValidProviderName(name)) {
      return jsonResponse({ error: "provider name must use letters, numbers, dot, underscore, or hyphen and cannot be a reserved object key" }, 400);
    }
    const providerError = providerManagementConfigError(name, prov);
    if (providerError) return jsonResponse({ error: providerError }, 400);
    // Hostname destinations additionally get a DNS-resolved SSRF check at write time —
    // the sync check above only classifies literal IPs (review finding, PR #96).
    const resolvedError = await providerDestinationResolvedError(name, prov);
    if (resolvedError) return jsonResponse({ error: resolvedError }, 400);
    // Catalog providers (e.g. ollama-cloud) carry a models + vision/reasoning classification the GUI
    // doesn't send — merge it in so the sidecars are gated correctly.
    enrichProviderFromCatalog(name, prov);
    const { saveConfig: save } = await import("../config");
    // Overwriting an existing provider must not drop its multi-key pool: carry it over, then
    // let the (possibly new) apiKey join the pool as the active entry.
    const existingPool = config.providers[name]?.apiKeyPool;
    if (existingPool && !prov.apiKeyPool) prov.apiKeyPool = existingPool;
    config.providers[name] = stripRegistryOnlyStaticHeaders(name, prov);
    if (body.setDefault) config.defaultProvider = name;
    save(config);
    if (prov.apiKey && prov.apiKeyPool) {
      const { addProviderApiKey } = await import("../providers/api-keys");
      addProviderApiKey(config, name, prov.apiKey);
    }
    const { clearModelCache } = await import("../codex/model-cache");
    clearModelCache(name);
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ success: true, name });
  }

  if (url.pathname === "/api/providers" && req.method === "PATCH") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    let body: {
      disabled?: unknown;
      adapter?: unknown;
      baseUrl?: unknown;
      defaultModel?: unknown;
      apiKey?: unknown;
      authMode?: unknown;
      note?: unknown;
    };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }

    const next: OcxProviderConfig = { ...config.providers[name]! };
    let touched = false;

    if ("disabled" in body) {
      if (typeof body.disabled !== "boolean") return jsonResponse({ error: "disabled must be a boolean" }, 400);
      if (body.disabled && name === config.defaultProvider) {
        return jsonResponse({ error: "cannot disable the default provider; set another default first" }, 400);
      }
      next.disabled = body.disabled;
      touched = true;
    }
    if (typeof body.adapter === "string" && body.adapter.trim()) {
      next.adapter = body.adapter.trim();
      touched = true;
    }
    if (typeof body.baseUrl === "string" && body.baseUrl.trim()) {
      next.baseUrl = body.baseUrl.trim();
      touched = true;
    }
    if (typeof body.defaultModel === "string") {
      const dm = body.defaultModel.trim();
      if (dm) next.defaultModel = dm;
      else delete next.defaultModel;
      touched = true;
    }
    if (typeof body.apiKey === "string") {
      // Non-empty replaces the key; empty leaves existing key unchanged (never round-trip secrets).
      if (body.apiKey.trim()) {
        next.apiKey = body.apiKey.trim();
        touched = true;
      }
    }
    if (typeof body.authMode === "string") {
      const mode = body.authMode.trim();
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
    if (typeof body.note === "string") {
      const note = body.note.trim();
      if (note) next.note = note;
      else delete next.note;
      touched = true;
    }

    if (!touched) return jsonResponse({ error: "no recognized fields to update" }, 400);

    const providerError = providerManagementConfigError(name, next);
    if (providerError) return jsonResponse({ error: providerError }, 400);
    const resolvedError = await providerDestinationResolvedError(name, next);
    if (resolvedError) return jsonResponse({ error: resolvedError }, 400);

    const { saveConfig: save } = await import("../config");
    config.providers[name] = stripRegistryOnlyStaticHeaders(name, next);
    save(config);
    const { clearModelCache } = await import("../codex/model-cache");
    clearModelCache(name);
    await refreshCodexCatalogBestEffort();
    return jsonResponse({
      success: true,
      name,
      disabled: config.providers[name]!.disabled === true,
      hasApiKey: !!config.providers[name]!.apiKey,
    });
  }

  // Lightweight connectivity probe: clear the model cache for this provider and re-resolve
  // models. Inspired by gateway "test connection" flows (probe, measure latency, report) —
  // uses our existing catalog path rather than inventing a separate health wire format.
  if (url.pathname === "/api/providers/test" && req.method === "POST") {
    const name = url.searchParams.get("name")?.trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) {
      return jsonResponse({ error: "unknown provider" }, 404);
    }
    const prov = config.providers[name]!;
    if (prov.disabled) {
      return jsonResponse({ ok: false, error: "Provider is disabled", latencyMs: 0 }, 200);
    }
    const { clearModelCache } = await import("../codex/model-cache");
    clearModelCache(name);
    const started = Date.now();
    try {
      const models = (await fetchAllModels(config)).filter(m => m.provider === name);
      const latencyMs = Date.now() - started;
      if (prov.authMode === "forward") {
        return jsonResponse({
          ok: true,
          latencyMs,
          models: models.length,
          message: "Passthrough provider is configured (forwards your Codex login; no upstream /models).",
        });
      }
      if (models.length === 0) {
        return jsonResponse({
          ok: false,
          latencyMs,
          models: 0,
          error: "No models returned. Check base URL, adapter, and credentials.",
        });
      }
      return jsonResponse({
        ok: true,
        latencyMs,
        models: models.length,
        message: `Connected — ${models.length} model${models.length === 1 ? "" : "s"} available.`,
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
    const { saveConfig: save } = await import("../config");
    delete config.providers[name];
    setProviderContextCap(config, name, false);
    save(config);
    const { clearModelCache: clearCache } = await import("../codex/model-cache");
    clearCache(name);
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ success: true });
  }

  if (url.pathname === "/api/models" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const disabled = new Set(config.disabledModels ?? []);
    // Native GPT passthrough rows lead (provider "openai", bare-slug namespaced ids): sourced
    // from the static supported set so a disabled model stays listed and re-enableable.
    const native = nativeModelRows(config).map(row => ({
      provider: "openai",
      id: row.slug,
      namespaced: row.slug,
      disabled: row.disabled,
      native: true,
      ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    }));
    return jsonResponse([...native, ...models.map(m => {
      const namespaced = `${m.provider}/${m.id}`;
      const contextCap = providerContextCap(config, m.provider);
      return {
        ...m,
        namespaced,
        disabled: disabled.has(namespaced),
        ...(contextCap !== undefined ? { contextCap, contextCapped: m.contextCapped === true } : {}),
      };
    })]);
  }

  if (url.pathname === "/api/provider-context-caps" && req.method === "GET") {
    return jsonResponse({ cap: DEFAULT_PROVIDER_CONTEXT_CAP, value: globalContextCapValue(config), caps: providerContextCaps(config) });
  }

  if (url.pathname === "/api/provider-context-caps" && req.method === "PUT") {
    let body: { provider?: unknown; enabled?: unknown; value?: unknown; setAll?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const { saveConfig: save } = await import("../config");
    const { clearModelCache } = await import("../codex/model-cache");
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

  // Enable/disable models: which routed models Codex sees. PUT hides them from the catalog +
  // /v1/models and invalidates Codex's 5-min models cache so it applies on the next turn.
  if (url.pathname === "/api/disabled-models" && req.method === "PUT") {
    let body: { models?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const disabled = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === "string") : [];
    config.disabledModels = disabled;
    const { saveConfig: save } = await import("../config");
    save(config);
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ ok: true, disabled });
  }

  // multi_agent_v2 surface toggle. GET reports the flag + the agents.max_threads
  // boot conflict; PUT flips it via the official `codex features` CLI and RESYNCS
  // the catalog so multi-agent surface metadata stays fresh. The catalog build
  // itself never writes config — this endpoint is the only server-side mutation
  // surface for the flag.
  if (url.pathname === "/api/v2" && req.method === "GET") {
    const { isMultiAgentV2Enabled, hasAgentsMaxThreads, getLogicalMaxThreads } = await import("../codex/features");
    const enabled = isMultiAgentV2Enabled();
    return jsonResponse({
      enabled,
      agentsMaxThreadsConflict: enabled && hasAgentsMaxThreads(),
      maxConcurrentThreadsPerSession: getLogicalMaxThreads(),
      multiAgentMode: config.multiAgentMode ?? "default",
    });
  }
  if (url.pathname === "/api/v2" && req.method === "PUT") {
    let body: { enabled?: unknown; maxConcurrentThreadsPerSession?: unknown; multiAgentMode?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const wantsFlag = body.enabled !== undefined;
    const wantsThreads = body.maxConcurrentThreadsPerSession !== undefined;
    const wantsMode = body.multiAgentMode !== undefined;
    if (!wantsFlag && !wantsThreads && !wantsMode) return jsonResponse({ error: "body must set enabled, multiAgentMode, and/or maxConcurrentThreadsPerSession" }, 400);
    if (wantsFlag && typeof body.enabled !== "boolean") return jsonResponse({ error: "body.enabled must be a boolean" }, 400);
    if (wantsMode && body.multiAgentMode !== "v1" && body.multiAgentMode !== "default" && body.multiAgentMode !== "v2") {
      return jsonResponse({ error: "body.multiAgentMode must be 'v1', 'default', or 'v2'" }, 400);
    }
    if (wantsThreads && (typeof body.maxConcurrentThreadsPerSession !== "number" || !Number.isInteger(body.maxConcurrentThreadsPerSession) || body.maxConcurrentThreadsPerSession < 1)) {
      return jsonResponse({ error: "body.maxConcurrentThreadsPerSession must be an integer >= 1" }, 400);
    }
    const mode = wantsMode ? body.multiAgentMode as "v1" | "default" | "v2" : undefined;
    const modeFlag = mode === "v2" ? true : mode === "v1" ? false : undefined;
    if (wantsFlag && modeFlag !== undefined && body.enabled !== modeFlag) {
      return jsonResponse({ error: `body.enabled conflicts with multiAgentMode '${mode}'` }, 400);
    }
    const { isMultiAgentV2Enabled, hasAgentsMaxThreads, getLogicalMaxThreads, transitionMultiAgentV2 } = await import("../codex/features");
    const warnings: string[] = [];
    const requestedFlag = wantsFlag ? body.enabled as boolean : modeFlag;
    if (requestedFlag !== undefined || wantsThreads) {
      const targetFlag = requestedFlag ?? isMultiAgentV2Enabled();
      let toggle = deps.toggleCodexMultiAgentV2;
      if (!toggle) {
        const { execFileSync } = await import("node:child_process");
        const { codexFeaturesInvocation } = await import("../cli/v2");
        toggle = (enabled: boolean) => {
          const inv = codexFeaturesInvocation(enabled ? "enable" : "disable");
          execFileSync(inv.file, inv.args,
            { stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, windowsHide: true, ...inv.options });
        };
      }
      const result = transitionMultiAgentV2(targetFlag, toggle, {
        ...(wantsThreads ? { threadLimit: body.maxConcurrentThreadsPerSession as number } : {}),
      });
      if (!result.ok) return jsonResponse({ error: `multi_agent_v2 transition failed: ${result.error}` }, 502);
      if (result.changed && result.threadLimit !== null) warnings.push(`Thread limit ${result.threadLimit} preserved for ${targetFlag ? "v2" : "v1"}.`);
    }
    if (wantsMode) {
      if (mode === "default") delete config.multiAgentMode;
      else config.multiAgentMode = mode;
      saveConfig(config);
      warnings.push(`Multi-agent mode set to '${mode}'. Applies to new sessions.`);
    }
    await refreshCodexCatalogBestEffort();
    if (requestedFlag !== undefined) warnings.push("Applies to new sessions; restart the Codex app or wait out its picker cache to see the ladder change.");
    const enabled = isMultiAgentV2Enabled();
    return jsonResponse({
      ok: true,
      enabled,
      agentsMaxThreadsConflict: enabled && hasAgentsMaxThreads(),
      maxConcurrentThreadsPerSession: getLogicalMaxThreads(),
      multiAgentMode: config.multiAgentMode ?? "default",
      warnings,
    });
  }

  // Which providers support real OAuth login (drives the GUI's "Log in with …" buttons).
  if (url.pathname === "/api/oauth/providers" && req.method === "GET") {
    return jsonResponse({ providers: listOAuthProviders() });
  }

  // API-key "login" providers (open dashboard → paste key). Drives the GUI's key-provider picker.
  if (url.pathname === "/api/key-providers" && req.method === "GET") {
    return jsonResponse({ providers: listKeyLoginProviders() });
  }

  // Complete GUI picker presets, derived from the canonical provider registry. The GUI is a
  // standalone Vite package, so it consumes this runtime view instead of importing repo-root src.
  if (url.pathname === "/api/provider-presets" && req.method === "GET") {
    return jsonResponse({ providers: deriveProviderPresets() });
  }

  // Subagent prompt injection model: single native or routed model whose info is
  // dynamically injected into the v1 proactive prompt, plus an optional reasoning
  // effort the prompt tells the agent to pass to spawn_agent. GET returns the current
  // picks + available models/efforts; PUT sets or clears them.
  if (url.pathname === "/api/injection-model" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const disabled = new Set(config.disabledModels ?? []);
    const { listCatalogNativeSlugs } = await import("../codex/catalog");
    const { CODEX_REASONING_LEVELS } = await import("../reasoning-effort");
    const nativeModels = listCatalogNativeSlugs()
      .filter(slug => !disabled.has(slug))
      .map(slug => ({ provider: "openai", model: slug, namespaced: slug }));
    const routedModels = models
      .map(m => ({ provider: m.provider, model: m.id, namespaced: `${m.provider}/${m.id}` }))
      .filter(m => !disabled.has(m.namespaced));
    return jsonResponse({
      model: config.injectionModel ?? null,
      effort: config.injectionEffort ?? null,
      prompt: config.injectionPrompt ?? null,
      efforts: CODEX_REASONING_LEVELS.map(l => l.effort),
      available: [...nativeModels, ...routedModels],
    });
  }
  if (url.pathname === "/api/injection-model" && req.method === "PUT") {
    let body: { model?: unknown; effort?: unknown; prompt?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const { isCodexReasoningEffort } = await import("../reasoning-effort");
    const model = typeof body.model === "string" && body.model.length > 0 ? body.model : undefined;
    let effort = config.injectionEffort;
    // `effort` key semantics: absent -> unchanged; null/"" -> clear; ladder value -> set;
    // anything else -> 400. Clearing the model always clears the effort (it is meaningless alone).
    if ("effort" in body) {
      const requestedEffort = typeof body.effort === "string" && body.effort.length > 0 ? body.effort : undefined;
      if (requestedEffort !== undefined && !isCodexReasoningEffort(requestedEffort)) {
        return jsonResponse({ error: `unknown reasoning effort "${requestedEffort}"` }, 400);
      }
      effort = requestedEffort;
    }
    if (!model) effort = undefined;
    if (model) config.injectionModel = model;
    else delete config.injectionModel;
    if (effort) config.injectionEffort = effort;
    else delete config.injectionEffort;
    // `prompt` key semantics mirror `effort`: absent -> unchanged; null/"" -> clear;
    // non-empty string -> set (custom <multi_agent_mode> body, {{model}}/{{effort}}/{{roster}} placeholders).
    if ("prompt" in body) {
      if (typeof body.prompt === "string" && body.prompt.trim().length > 0) config.injectionPrompt = body.prompt;
      else if (body.prompt === null || body.prompt === "") delete config.injectionPrompt;
      else return jsonResponse({ error: "prompt must be a string or null" }, 400);
    }
    saveConfig(config);
    return jsonResponse({ ok: true, model: config.injectionModel ?? null, effort: config.injectionEffort ?? null, prompt: config.injectionPrompt ?? null });
  }

  // Hard reasoning-effort caps (devlog/260710_subagent_effort_intercept): a global ceiling and a
  // sub-agent-only ceiling, enforced per-request in handleResponses (src/server/effort-policy.ts).
  // Key semantics per field: absent -> unchanged; null/"" -> clear; ladder value -> set; else 400.
  if (url.pathname === "/api/effort-caps" && req.method === "GET") {
    const { CODEX_REASONING_LEVELS } = await import("../reasoning-effort");
    return jsonResponse({
      effortCap: config.effortCap ?? null,
      subagentEffortCap: config.subagentEffortCap ?? null,
      efforts: CODEX_REASONING_LEVELS.map(l => l.effort),
    });
  }
  if (url.pathname === "/api/effort-caps" && req.method === "PUT") {
    let body: { effortCap?: unknown; subagentEffortCap?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const { isCodexReasoningEffort } = await import("../reasoning-effort");
    for (const key of ["effortCap", "subagentEffortCap"] as const) {
      if (!(key in body)) continue;
      const value = body[key];
      if (value === null || value === "") { delete config[key]; continue; }
      if (typeof value !== "string" || !isCodexReasoningEffort(value)) {
        return jsonResponse({ error: `unknown reasoning effort "${String(value)}"` }, 400);
      }
      config[key] = value;
    }
    saveConfig(config);
    return jsonResponse({ ok: true, effortCap: config.effortCap ?? null, subagentEffortCap: config.subagentEffortCap ?? null });
  }

  // Subagent model picker: which ≤5 routed models Codex's spawn_agent advertises (it shows the
  // first 5 routed catalog entries). PUT reorders the injected catalog so the chosen ones lead.
  if (url.pathname === "/api/subagent-models" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const disabled = new Set(config.disabledModels ?? []);
    // Native gpt (passthrough) are also valid subagent picks — they're picker-visible models in the
    // catalog, just buried by priority. List them first so the user can feature them over routed.
    const { listCatalogNativeSlugs } = await import("../codex/catalog");
    const available = [
      ...listCatalogNativeSlugs(),
      ...models.map(m => `${m.provider}/${m.id}`),
    ].filter(ns => !disabled.has(ns));
    return jsonResponse({ chosen: config.subagentModels ?? [], available });
  }
  if (url.pathname === "/api/subagent-models" && req.method === "PUT") {
    let body: { models?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const chosen = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === "string").slice(0, 5) : [];
    config.subagentModels = chosen;
    const { saveConfig: save } = await import("../config");
    save(config);
    await refreshCodexCatalogBestEffort();
    await syncClaudeAgentDefsBestEffort();
    return jsonResponse({ ok: true, applied: chosen });
  }

  // Claude Code inbound settings (GUI "Claude ON" toggle + Claude page).
  if (url.pathname === "/api/claude-code" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const { listCatalogNativeSlugs } = await import("../codex/catalog");
    const { claudeCodeAlias, claudeCodeNativeAlias } = await import("../claude/alias");
    const { buildClaudeContextWindows, effectiveModelEnv } = await import("../claude/context-windows");
    const { visibleNativeSlugs } = await import("../codex/catalog");
    const disabled = new Set(config.disabledModels ?? []);
    const available = [
      ...listCatalogNativeSlugs(),
      ...models.map(m => `${m.provider}/${m.id}`),
    ].filter(ns => !disabled.has(ns));
    const aliases: { id: string; display_name: string }[] = [];
    for (const slug of listCatalogNativeSlugs()) {
      // Readable CLI-surface alias with hash fallback (devlog 050 / audit 051 #2) —
      // the same shared helper the /v1/models ?ids=cli path uses.
      if (!disabled.has(slug)) aliases.push({ id: claudeCodeNativeAlias(slug), display_name: `${slug} (native)` });
    }
    for (const m of models) {
      if (disabled.has(`${m.provider}/${m.id}`)) continue;
      aliases.push({ id: claudeCodeAlias(m.provider, m.id), display_name: `${m.id} (${m.provider})` });
    }
    const contextWindows = buildClaudeContextWindows([...visibleNativeSlugs(config)], models);
    const webSearchOverride = config.claudeCode?.webSearchSidecar;
    const visionOverride = config.claudeCode?.visionSidecar;
    return jsonResponse({
      enabled: config.claudeCode?.enabled !== false,
      model: config.claudeCode?.model ?? "",
      smallFastModel: config.claudeCode?.smallFastModel ?? "",
      tierModels: config.claudeCode?.tierModels ?? {},
      modelMap: config.claudeCode?.modelMap ?? {},
      systemEnv: config.claudeCode?.systemEnv === true,
      maxContextTokens: config.claudeCode?.maxContextTokens ?? null,
      alwaysEnableEffort: config.claudeCode?.alwaysEnableEffort === true,
      autoContext: config.claudeCode?.autoContext !== false,
      autoCompactWindow: config.claudeCode?.autoCompactWindow ?? null,
      blockedSkills: config.claudeCode?.blockedSkills ?? null,
      injectAgents: config.claudeCode?.injectAgents !== false,
      ...(webSearchOverride && Object.keys(webSearchOverride).length > 0
        ? { webSearchSidecar: { backend: webSearchOverride.backend, model: webSearchOverride.model } }
        : {}),
      ...(visionOverride && Object.keys(visionOverride).length > 0
        ? { visionSidecar: { backend: visionOverride.backend, model: visionOverride.model } }
        : {}),
      fastMode: config.fastMode,
      contextWindows,
      effectiveModelEnv: effectiveModelEnv(config.claudeCode, contextWindows),
      available,
      aliases,
      port: config.port,
    });
  }
  if (url.pathname === "/api/claude-code" && req.method === "PUT") {
    // NOTE: model / tierModels / maxContextTokens / alwaysEnableEffort are
    // CONFIG-ONLY back-compat fields — the GUI no longer offers controls for them
    // (default model is owned by Claude Code's /model picker; roster agents
    // supersede tiers; auto-context supersedes the max-context pair; effort rides
    // regardless on 2.1.207). PUT keeps validating them so hand-written configs
    // and older GUIs stay safe; GUI saves omit them and the spread preserves them.
    let parsedBody: unknown;
    try { parsedBody = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const isPlainObject = (value: unknown): value is Record<string, unknown> => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    };
    if (!isPlainObject(parsedBody)) return jsonResponse({ error: "body must be an object" }, 400);
    const body = parsedBody as { enabled?: unknown; model?: unknown; smallFastModel?: unknown; modelMap?: unknown; systemEnv?: unknown; fastMode?: unknown; maxContextTokens?: unknown; alwaysEnableEffort?: unknown; tierModels?: unknown; autoContext?: unknown; autoCompactWindow?: unknown; blockedSkills?: unknown; injectAgents?: unknown; webSearchSidecar?: unknown; visionSidecar?: unknown };
    for (const field of ["webSearchSidecar", "visionSidecar"] as const) {
      const section = body[field];
      if (section === undefined || section === null) continue;
      if (!isPlainObject(section)) return jsonResponse({ error: `${field} must be an object or null` }, 400);
      if (section.backend !== undefined && section.backend !== null
        && section.backend !== "openai" && section.backend !== "anthropic") {
        return jsonResponse({ error: `${field}.backend must be openai, anthropic, or null` }, 400);
      }
      if (section.model !== undefined && typeof section.model !== "string") {
        return jsonResponse({ error: `${field}.model must be a string` }, 400);
      }
    }
    const next = { ...(config.claudeCode ?? {}) };
    for (const field of ["webSearchSidecar", "visionSidecar"] as const) {
      const section = body[field];
      if (section === undefined) continue;
      if (section === null || Object.keys(section as Record<string, unknown>).length === 0) {
        delete next[field];
        continue;
      }
      const requested = section as { backend?: "openai" | "anthropic" | null; model?: string };
      const override: NonNullable<OcxClaudeCodeConfig[typeof field]> = { ...next[field] };
      if (requested.backend === null) delete override.backend;
      else if (requested.backend !== undefined) override.backend = requested.backend;
      if (requested.model === "") delete override.model;
      else if (requested.model !== undefined) override.model = requested.model;
      if (Object.keys(override).length > 0) next[field] = override;
      else delete next[field];
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") return jsonResponse({ error: "enabled must be a boolean" }, 400);
      next.enabled = body.enabled;
    }
    if (body.systemEnv !== undefined) {
      if (typeof body.systemEnv !== "boolean") return jsonResponse({ error: "systemEnv must be a boolean" }, 400);
      next.systemEnv = body.systemEnv;
    }
    if (body.alwaysEnableEffort !== undefined) {
      if (typeof body.alwaysEnableEffort !== "boolean") return jsonResponse({ error: "alwaysEnableEffort must be a boolean" }, 400);
      if (body.alwaysEnableEffort) next.alwaysEnableEffort = true;
      else delete next.alwaysEnableEffort;
    }
    if (body.maxContextTokens !== undefined) {
      // CONFIG-ONLY back-compat (GUI control removed — superseded by auto-context):
      // null clears; otherwise a positive integer (devlog 136 B6).
      if (body.maxContextTokens === null) {
        delete next.maxContextTokens;
      } else if (typeof body.maxContextTokens !== "number" || !Number.isInteger(body.maxContextTokens) || body.maxContextTokens <= 0) {
        return jsonResponse({ error: "maxContextTokens must be a positive integer or null" }, 400);
      } else {
        next.maxContextTokens = body.maxContextTokens;
      }
    }
    if (body.autoContext !== undefined) {
      // Default-on boolean (devlog 260712 020): true = drop the key, false = store.
      if (typeof body.autoContext !== "boolean") return jsonResponse({ error: "autoContext must be a boolean" }, 400);
      if (body.autoContext) delete next.autoContext;
      else next.autoContext = false;
    }
    if (body.injectAgents !== undefined) {
      // Default-on boolean (devlog 260712 070): true = drop the key, false = store.
      if (typeof body.injectAgents !== "boolean") return jsonResponse({ error: "injectAgents must be a boolean" }, 400);
      if (body.injectAgents) delete next.injectAgents;
      else next.injectAgents = false;
    }
    if (body.autoCompactWindow !== undefined) {
      // null resets to the 350k default; otherwise the binary-accepted range
      // 100_000..1_000_000 (2.1.207 pSo/yDs — audit 021 #1).
      if (body.autoCompactWindow === null) {
        delete next.autoCompactWindow;
      } else if (typeof body.autoCompactWindow !== "number" || !Number.isInteger(body.autoCompactWindow) || body.autoCompactWindow < 100_000 || body.autoCompactWindow > 1_000_000) {
        return jsonResponse({ error: "autoCompactWindow must be an integer between 100000 and 1000000, or null" }, 400);
      } else {
        next.autoCompactWindow = body.autoCompactWindow;
      }
    }
    if (body.blockedSkills !== undefined) {
      // null resets to the default (["claude-api"]); an array (possibly empty = off)
      // must contain non-empty strings (devlog 060).
      if (body.blockedSkills === null) {
        delete next.blockedSkills;
      } else if (!Array.isArray(body.blockedSkills) || body.blockedSkills.some(s => typeof s !== "string" || s.trim() === "")) {
        return jsonResponse({ error: "blockedSkills must be an array of non-empty strings, or null" }, 400);
      } else {
        next.blockedSkills = (body.blockedSkills as string[]).map(s => s.trim());
      }
    }
    if (body.tierModels !== undefined) {
      // CONFIG-ONLY back-compat (GUI pickers removed — roster agents supersede tiers).
      if (body.tierModels === null) {
        delete next.tierModels;
      } else if (!isPlainObject(body.tierModels)) {
        return jsonResponse({ error: "tierModels must be an object with string values, or null" }, 400);
      } else {
        for (const [tier, value] of Object.entries(body.tierModels)) {
          if (typeof value !== "string") return jsonResponse({ error: `tierModels.${tier} must be a string` }, 400);
        }
        const tierModels = body.tierModels as Record<string, string>;
        const tiers: Record<string, string> = {};
        for (const tier of ["opus", "sonnet", "haiku", "fable"] as const) {
          const value = tierModels[tier];
          if (value !== undefined && value.trim() !== "") tiers[tier] = value.trim();
        }
        if (Object.keys(tiers).length > 0) next.tierModels = tiers;
        else delete next.tierModels;
      }
    }
    if (body.fastMode !== undefined) {
      if (body.fastMode !== true && body.fastMode !== false && body.fastMode !== null) {
        return jsonResponse({ error: "fastMode must be true, false, or null" }, 400);
      }
      config.fastMode = body.fastMode === null ? undefined : body.fastMode;
    }
    for (const field of ["model", "smallFastModel"] as const) {
      const value = body[field];
      if (value === undefined) continue;
      if (typeof value !== "string") return jsonResponse({ error: `${field} must be a string` }, 400);
      if (value.trim() === "") delete next[field];
      else next[field] = value.trim();
    }
    if (body.modelMap !== undefined) {
      if (body.modelMap === null) {
        delete next.modelMap;
      } else {
        if (!isPlainObject(body.modelMap)) {
          return jsonResponse({ error: "modelMap must be an object of string->string, or null" }, 400);
        }
        const map: Record<string, string> = {};
        for (const [k, v] of Object.entries(body.modelMap)) {
          if (typeof v !== "string" || k.trim() === "" || v.trim() === "") {
            return jsonResponse({ error: "modelMap entries must be non-empty strings" }, 400);
          }
          map[k.trim()] = v.trim();
        }
        if (Object.keys(map).length > 0) next.modelMap = map;
        else delete next.modelMap;
      }
    }
    config.claudeCode = next;
    const { saveConfig: save } = await import("../config");
    save(config);
    const warnings: string[] = [];
    if (body.systemEnv !== undefined) {
      try {
        await applySystemEnvToggle(config, config.port);
      } catch (err) {
        warnings.push(`Failed to apply system environment setting: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Keep the file-backed live registry symmetric: OFF prunes immediately, while
    // ON and config changes restore definitions without requiring a restart.
    await syncClaudeAgentDefsBestEffort();
    return jsonResponse({ ok: true, enabled: next.enabled !== false, warnings });
  }

  // Per-provider catalog allowlist (issue #52): when a provider has a non-empty selectedModels list,
  // only those ids ship to Codex's catalog / /v1/models. GET returns the CURRENT selection plus the
  // FULL available set per provider (unfiltered — the picker needs everything to choose from).
  if (url.pathname === "/api/selected-models" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const available: Record<string, string[]> = {};
    for (const m of models) (available[m.provider] ??= []).push(m.id);
    const selected: Record<string, string[]> = {};
    for (const [name, prov] of Object.entries(config.providers)) {
      if (Array.isArray(prov.selectedModels) && prov.selectedModels.length > 0) selected[name] = [...prov.selectedModels];
    }
    return jsonResponse({ selected, available });
  }
  if (url.pathname === "/api/selected-models" && req.method === "PUT") {
    let body: { provider?: unknown; models?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
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
    const { saveConfig: save } = await import("../config");
    save(config);
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ ok: true, provider, selected: models });
  }

  // OAuth login (xai now; anthropic/kimi in cycle 2). Starts the flow and returns the auth URL;
  // the provider's loopback callback server (inside this process) captures the redirect in the
  // background, then the credential is persisted. The GUI opens the URL and polls /api/oauth/status.
  if (url.pathname === "/api/oauth/login" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { provider?: string; addAccount?: boolean };
    const provider = (body.provider ?? "").trim().toLowerCase();
    if (!isOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    try {
      // addAccount forces a fresh browser identity (skips local-CLI token import) so a
      // SECOND account can be added instead of re-importing the first one.
      const { url: authUrl, instructions } = await startLoginFlow(provider, body.addAccount ? { forceLogin: true } : undefined);
      upsertOAuthProvider(config, provider); // mutate LIVE config — routing sees it without restart
      if (authUrl) {
        // Open the browser server-side (the proxy runs on the user's machine) — the GUI's
        // window.open is popup-blocked because it runs after an await, not a direct click.
        const { openUrl } = await import("../lib/open-url");
        openUrl(authUrl);
      }
      return jsonResponse({ url: authUrl, instructions });
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  }

  // Cancel an in-progress browser/device OAuth login (GUI "Cancel" / close modal).
  if (url.pathname === "/api/oauth/login/cancel" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { provider?: string };
    const provider = (body.provider ?? "").trim().toLowerCase();
    if (!isOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    const cancelled = cancelLoginFlow(provider);
    return jsonResponse({ ok: true, cancelled });
  }

  // Manual fallback for browser OAuth: paste the final redirect URL (or authorization code)
  // when the browser cannot reach the loopback callback (remote/SSH/blocked localhost).
  if (url.pathname === "/api/oauth/login/code" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { provider?: string; input?: string; code?: string };
    const provider = (body.provider ?? "").trim().toLowerCase();
    if (!isOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    const input = typeof body.input === "string" ? body.input : typeof body.code === "string" ? body.code : "";
    // Authorization responses are measured in hundreds of bytes; never accept the
    // generic management-body allowance here.
    if (input.length > 4096) return jsonResponse({ error: "input too long" }, 400);
    const result = submitManualLoginCode(provider, input);
    if (!result.ok) return jsonResponse({ error: result.error }, 409);
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/oauth/status" && req.method === "GET") {
    const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();
    return jsonResponse(getLoginStatus(provider));
  }

  if (url.pathname === "/api/oauth/logout" && req.method === "POST") {
    const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();
    if (!isOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    removeCredential(provider);
    clearLoginState(provider);
    return jsonResponse({ success: true });
  }

  // Multiauth account management: list a provider's logged-in accounts, switch the active
  // one, or remove one. Emails are masked; tokens never leave the store.
  if (url.pathname === "/api/oauth/accounts" && req.method === "GET") {
    const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();
    if (!isOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    const status = getLoginStatus(provider);
    return jsonResponse({ activeAccountId: status.activeAccountId ?? null, accounts: status.accounts ?? [] });
  }
  if (url.pathname === "/api/oauth/accounts/active" && req.method === "PUT") {
    const body = await req.json().catch(() => ({})) as { provider?: string; accountId?: string };
    const provider = (body.provider ?? "").trim().toLowerCase();
    if (!isOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    if (!body.accountId) return jsonResponse({ error: "missing accountId" }, 400);
    const { setActiveAccount } = await import("../oauth/store");
    if (!setActiveAccount(provider, body.accountId)) return jsonResponse({ error: "account not found" }, 404);
    const { clearProviderQuotaCache } = await import("../providers/quota");
    clearProviderQuotaCache();
    return jsonResponse({ ok: true, provider, activeAccountId: body.accountId });
  }
  if (url.pathname === "/api/oauth/accounts" && req.method === "DELETE") {
    const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();
    const id = url.searchParams.get("id") ?? "";
    if (!isOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    if (!id) return jsonResponse({ error: "missing id" }, 400);
    const { removeAccount, getAccountSet } = await import("../oauth/store");
    if (!removeAccount(provider, id)) return jsonResponse({ error: "account not found" }, 404);
    if (!getAccountSet(provider)) clearLoginState(provider);
    const { clearProviderQuotaCache } = await import("../providers/quota");
    clearProviderQuotaCache();
    return jsonResponse({ ok: true });
  }

  // Multi-key pool for API-key providers (same GUI dropdown as OAuth multiauth): list masked
  // keys, add one (upserts + activates), switch the active key, or remove one. `apiKey` always
  // mirrors the active entry so routing is untouched.
  if (url.pathname === "/api/providers/keys" && req.method === "GET") {
    const name = (url.searchParams.get("name") ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    const { listProviderApiKeys } = await import("../providers/api-keys");
    return jsonResponse(listProviderApiKeys(config, name));
  }
  if (url.pathname === "/api/providers/keys" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { name?: string; key?: string; label?: string };
    const name = (body.name ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    if (typeof body.key !== "string" || !body.key.trim()) return jsonResponse({ error: "key is required" }, 400);
    const { addProviderApiKey } = await import("../providers/api-keys");
    const result = addProviderApiKey(config, name, body.key, body.label);
    if ("error" in result) return jsonResponse({ error: result.error }, 400);
    const { clearModelCache } = await import("../codex/model-cache");
    clearModelCache(name);
    const { clearProviderQuotaCache } = await import("../providers/quota");
    clearProviderQuotaCache();
    const { clearKeyCooldowns } = await import("../providers/key-failover");
    clearKeyCooldowns(name); // manual key management resets 429 cooldown state
    return jsonResponse({ ok: true, id: result.id }, 201);
  }
  if (url.pathname === "/api/providers/keys/active" && req.method === "PUT") {
    const body = await req.json().catch(() => ({})) as { name?: string; id?: string };
    const name = (body.name ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    if (!body.id) return jsonResponse({ error: "missing id" }, 400);
    const { setActiveProviderApiKey } = await import("../providers/api-keys");
    if (!setActiveProviderApiKey(config, name, body.id)) return jsonResponse({ error: "key not found" }, 404);
    const { clearModelCache } = await import("../codex/model-cache");
    clearModelCache(name);
    const { clearProviderQuotaCache } = await import("../providers/quota");
    clearProviderQuotaCache();
    const { clearKeyCooldowns } = await import("../providers/key-failover");
    clearKeyCooldowns(name); // manual key management resets 429 cooldown state
    return jsonResponse({ ok: true, name, activeId: body.id });
  }
  if (url.pathname === "/api/providers/keys" && req.method === "DELETE") {
    const name = (url.searchParams.get("name") ?? "").trim();
    const id = url.searchParams.get("id") ?? "";
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    if (!id) return jsonResponse({ error: "missing id" }, 400);
    const { removeProviderApiKey } = await import("../providers/api-keys");
    if (!removeProviderApiKey(config, name, id)) return jsonResponse({ error: "key not found" }, 404);
    const { clearModelCache } = await import("../codex/model-cache");
    clearModelCache(name);
    const { clearProviderQuotaCache } = await import("../providers/quota");
    clearProviderQuotaCache();
    const { clearKeyCooldowns } = await import("../providers/key-failover");
    clearKeyCooldowns(name); // manual key management resets 429 cooldown state
    return jsonResponse({ ok: true });
  }

  // ---------------------------------------------------------------------------
  // API Keys management
  // ---------------------------------------------------------------------------
  if (url.pathname === "/api/keys" && req.method === "GET") {
    const keys = config.apiKeys ?? [];
    return jsonResponse({ keys: keys.map(k => ({ id: k.id, name: k.name, prefix: k.key.slice(0, 8) + "...", createdAt: k.createdAt })), endpoint: `http://${config.hostname ?? "127.0.0.1"}:${config.port ?? 10100}/v1/responses` }, 200, req, config);
  }

  if (url.pathname === "/api/keys" && req.method === "POST") {
    const body = await req.json() as { name?: string };
    const name = (body.name ?? "").trim() || "default";
    // Generate key from provider keys hash + random salt
    const providerKeys = Object.values(config.providers).map(p => p.apiKey ?? "").filter(Boolean).join("|");
    const salt = crypto.randomUUID();
    const hashInput = `${providerKeys}|${salt}|${Date.now()}`;
    const hashBuf = new Bun.CryptoHasher("sha256").update(hashInput).digest();
    const key = "ocx_" + Buffer.from(hashBuf).toString("hex").slice(0, 40);
    const entry = { id: crypto.randomUUID(), name, key, createdAt: new Date().toISOString() };
    config.apiKeys = [...(config.apiKeys ?? []), entry];
    saveConfig(config);
    return jsonResponse({ id: entry.id, name: entry.name, key: entry.key, createdAt: entry.createdAt }, 201, req, config);
  }

  if (url.pathname === "/api/keys" && req.method === "DELETE") {
    const body = await req.json() as { id?: string };
    if (!body.id) return jsonResponse({ error: "id required" }, 400, req, config);
    config.apiKeys = (config.apiKeys ?? []).filter(k => k.id !== body.id);
    saveConfig(config);
    return jsonResponse({ success: true }, 200, req, config);
  }

  if (url.pathname === "/api/stop" && req.method === "POST") {
    const { restoreNativeCodex } = await import("../codex/inject");
    const { stopServiceIfInstalled } = await import("../service");
    stopServiceIfInstalled();
    const restore = restoreNativeCodex();
    setTimeout(async () => {
      await drainAndShutdown(undefined, config.shutdownTimeoutMs ?? 5000);
      process.exit(0);
    }, 200);
    return jsonResponse(restore.success
      ? { success: true, message: "Proxy stopping, native Codex restored." }
      : { success: false, message: `Proxy stopping, but native Codex restore failed: ${restore.message}. Run \`ocx restore\`.` });
  }

  if (url.pathname.startsWith("/api/codex-auth/")) {
    const { handleCodexAuthAPI } = await import("../codex/auth-api");
    return handleCodexAuthAPI(req, url, config);
  }

  return null;
}

/**
 * Live routed-provider models for the proxy's /api/* and /v1/models endpoints. Delegates to the
 * canonical, TTL-cached `gatherRoutedModels` (single source of truth) — so the GUI/codex endpoints
 * share the same fetch, the same per-provider cache (dedups Codex's frequent /v1/models polling),
 * and the same stale fallback when a provider blips, instead of a parallel uncached copy.
 */
export async function fetchAllModels(config: OcxConfig): Promise<CatalogModel[]> {
  const { gatherRoutedModels } = await import("../codex/catalog");
  return gatherRoutedModels(config);
}

function stripRegistryOnlyStaticHeaders(name: string, provider: OcxProviderConfig): OcxProviderConfig {
  const entry = getProviderRegistryEntry(name);
  if (!entry?.staticHeaders || !provider.headers) return provider;
  const headerEntries = Object.entries(provider.headers);
  const staticEntries = Object.entries(entry.staticHeaders);
  if (headerEntries.length !== staticEntries.length) return provider;
  const matchesRegistryStaticHeaders = staticEntries.every(([key, value]) => provider.headers?.[key] === value);
  if (!matchesRegistryStaticHeaders) return provider;
  const { headers: _headers, ...rest } = provider;
  return rest;
}
