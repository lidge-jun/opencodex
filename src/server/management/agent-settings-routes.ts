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
import { deriveProviderPresets } from "../../providers/derive";
import { providerCodexAccountMode } from "../../providers/registry";
import { routedSlug, slugEquals } from "../../providers/slug-codec";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../../providers/quota";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { clearThreadAccountMap } from "../../codex/routing";
import { primeCodexPoolQuotas } from "../../codex/auth-api";
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

export async function handleAgentSettingsRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps, refreshCodexCatalogBestEffort, syncClaudeAgentDefsBestEffort } = ctx;

  // multi_agent_v2 surface toggle. GET reports the flag + the agents.max_threads
  // boot conflict; PUT flips it via the official `codex features` CLI and RESYNCS
  // the catalog so multi-agent surface metadata stays fresh. The catalog build
  // itself never writes config — this endpoint is the only server-side mutation
  // surface for the flag.
  if (url.pathname === "/api/v2" && req.method === "GET") {
    const { isMultiAgentV2Enabled, hasAgentsMaxThreads, getLogicalMaxThreads } = await import("../../codex/features");
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
    const { isMultiAgentV2Enabled, hasAgentsMaxThreads, getLogicalMaxThreads, transitionMultiAgentV2 } = await import("../../codex/features");
    const warnings: string[] = [];
    const requestedFlag = wantsFlag ? body.enabled as boolean : modeFlag;
    if (requestedFlag !== undefined || wantsThreads) {
      const targetFlag = requestedFlag ?? isMultiAgentV2Enabled();
      let toggle = deps.toggleCodexMultiAgentV2;
      if (!toggle) {
        const { execFileSync } = await import("node:child_process");
        const { codexFeaturesInvocation } = await import("../../cli/v2");
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

  // Subagent prompt injection model: single native or routed model whose info is
  // dynamically injected into the v1 proactive prompt, plus an optional reasoning
  // effort the prompt tells the agent to pass to spawn_agent. GET returns the current
  // picks + available models/efforts; PUT sets or clears them.
  if (url.pathname === "/api/injection-model" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const disabled = new Set(config.disabledModels ?? []);
    const { listCatalogNativeSlugs } = await import("../../codex/catalog");
    const { CODEX_REASONING_LEVELS } = await import("../../reasoning-effort");
    const nativeModels = listCatalogNativeSlugs()
      .filter(slug => !disabled.has(slug))
      .map(slug => ({ provider: "openai", model: slug, namespaced: slug }));
    const routedModels = uniqueCatalogModelsForPublicList(models)
      .map(m => ({ provider: m.provider, model: m.id, namespaced: catalogModelSlug(m) }))
      .filter(m => ![...disabled].some(stored => (
        stored === m.namespaced || slugEquals(stored, m.provider, m.model)
      )));
    return jsonResponse({
      multiAgentGuidanceEnabled: multiAgentGuidanceEnabled(config),
      model: config.injectionModel ?? null,
      effort: config.injectionEffort ?? null,
      prompt: config.injectionPrompt ?? null,
      efforts: CODEX_REASONING_LEVELS.map(l => l.effort),
      available: [...nativeModels, ...routedModels],
    });
  }
  if (url.pathname === "/api/injection-model" && req.method === "PUT") {
    let parsedBody: unknown;
    try { parsedBody = await req.json(); } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      return jsonResponse({ error: "body must be a JSON object" }, 400);
    }
    const body = parsedBody as {
      multiAgentGuidanceEnabled?: unknown;
      model?: unknown;
      effort?: unknown;
      prompt?: unknown;
    };
    const { isCodexReasoningEffort } = await import("../../reasoning-effort");

    let nextEnabled = config.multiAgentGuidanceEnabled;
    let nextModel = config.injectionModel;
    let nextEffort = config.injectionEffort;
    let nextPrompt = config.injectionPrompt;

    if ("multiAgentGuidanceEnabled" in body) {
      if (typeof body.multiAgentGuidanceEnabled !== "boolean") {
        return jsonResponse({ error: "multiAgentGuidanceEnabled must be a boolean" }, 400);
      }
      nextEnabled = body.multiAgentGuidanceEnabled;
    }
    if ("model" in body) {
      if (body.model === null || body.model === "") nextModel = undefined;
      else if (typeof body.model === "string" && body.model.length > 0) nextModel = body.model;
      else return jsonResponse({ error: "model must be a non-empty string or null" }, 400);
    }
    if ("effort" in body) {
      if (body.effort === null || body.effort === "") nextEffort = undefined;
      else if (typeof body.effort === "string" && isCodexReasoningEffort(body.effort)) {
        nextEffort = body.effort;
      } else {
        return jsonResponse({ error: `unknown reasoning effort "${String(body.effort)}"` }, 400);
      }
    }
    if ("prompt" in body) {
      if (typeof body.prompt === "string" && body.prompt.trim().length > 0) nextPrompt = body.prompt;
      else if (body.prompt === null || body.prompt === "") nextPrompt = undefined;
      else return jsonResponse({ error: "prompt must be a string or null" }, 400);
    }
    // Clearing the model always clears the effort (it is meaningless alone).
    if (!nextModel) nextEffort = undefined;

    config.multiAgentGuidanceEnabled = nextEnabled;
    if (nextModel) config.injectionModel = nextModel;
    else delete config.injectionModel;
    if (nextEffort) config.injectionEffort = nextEffort;
    else delete config.injectionEffort;
    if (nextPrompt) config.injectionPrompt = nextPrompt;
    else delete config.injectionPrompt;

    saveConfig(config);
    return jsonResponse({
      ok: true,
      multiAgentGuidanceEnabled: multiAgentGuidanceEnabled(config),
      model: config.injectionModel ?? null,
      effort: config.injectionEffort ?? null,
      prompt: config.injectionPrompt ?? null,
    });
  }

  // Hard reasoning-effort caps (devlog/260710_subagent_effort_intercept): a global ceiling and a
  // sub-agent-only ceiling, enforced per-request in handleResponses (src/server/effort-policy.ts).
  // Key semantics per field: absent -> unchanged; null/"" -> clear; ladder value -> set; else 400.
  if (url.pathname === "/api/effort-caps" && req.method === "GET") {
    const { CODEX_REASONING_LEVELS } = await import("../../reasoning-effort");
    return jsonResponse({
      effortCap: config.effortCap ?? null,
      subagentEffortCap: config.subagentEffortCap ?? null,
      efforts: CODEX_REASONING_LEVELS.map(l => l.effort),
    });
  }
  if (url.pathname === "/api/effort-caps" && req.method === "PUT") {
    let body: { effortCap?: unknown; subagentEffortCap?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const { isCodexReasoningEffort } = await import("../../reasoning-effort");
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
    const { listCatalogNativeSlugs } = await import("../../codex/catalog");
    const visibleRouted = [...new Set(models
      .filter(m => ![...disabled].some(stored =>
        stored === catalogModelSlug(m) || slugEquals(stored, m.provider, m.id)
      ))
      .map(catalogModelSlug))];
    const available = [
      ...listCatalogNativeSlugs().filter(ns => !disabled.has(ns)),
      ...visibleRouted,
    ];
    return jsonResponse({ chosen: config.subagentModels ?? [], available });
  }
  if (url.pathname === "/api/subagent-models" && req.method === "PUT") {
    let body: { models?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const chosen = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === "string").slice(0, 5) : [];
    config.subagentModels = chosen;
    const { saveConfig: save } = await import("../../config");
    save(config);
    await refreshCodexCatalogBestEffort();
    await syncClaudeAgentDefsBestEffort();
    return jsonResponse({ ok: true, applied: chosen });
  }

  // Priority-ordered subagent model fallback chain for quota-aware spawn routing.
  if (url.pathname === "/api/subagent-model-fallback" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const disabled = new Set(config.disabledModels ?? []);
    const { listCatalogNativeSlugs } = await import("../../codex/catalog");
    const visibleRouted = [...new Set(models
      .filter(m => ![...disabled].some(stored =>
        stored === catalogModelSlug(m) || slugEquals(stored, m.provider, m.id)
      ))
      .map(catalogModelSlug))];
    const available = [
      ...listCatalogNativeSlugs().filter(ns => !disabled.has(ns)),
      ...visibleRouted,
    ];
    return jsonResponse({
      models: config.subagentModelFallback ?? [],
      pollMs: config.subagentModelFallbackPollMs ?? 60_000,
      available,
    });
  }
  if (url.pathname === "/api/subagent-model-fallback" && req.method === "PUT") {
    let body: { models?: unknown; pollMs?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    let nextModels = config.subagentModelFallback;
    let nextPollMs = config.subagentModelFallbackPollMs;
    if ("models" in body) {
      if (!Array.isArray(body.models)) return jsonResponse({ error: "models must be an array" }, 400);
      const models = body.models.filter((m): m is string => typeof m === "string" && m.trim().length > 0);
      nextModels = models.length > 0 ? models : undefined;
    }
    if ("pollMs" in body) {
      const pollMs = body.pollMs;
      if (pollMs === null || pollMs === "") nextPollMs = undefined;
      else if (typeof pollMs === "number" && Number.isInteger(pollMs) && pollMs >= 5_000 && pollMs <= 600_000) {
        nextPollMs = pollMs;
      } else {
        return jsonResponse({ error: "pollMs must be an integer between 5000 and 600000" }, 400);
      }
    }
    if (nextModels !== undefined) config.subagentModelFallback = nextModels;
    else delete config.subagentModelFallback;
    if (nextPollMs !== undefined) config.subagentModelFallbackPollMs = nextPollMs;
    else delete config.subagentModelFallbackPollMs;
    saveConfig(config);
    return jsonResponse({
      ok: true,
      models: config.subagentModelFallback ?? [],
      pollMs: config.subagentModelFallbackPollMs ?? 60_000,
    });
  }

  // Claude Code inbound settings (GUI "Claude ON" toggle + Claude page).
  if (url.pathname === "/api/claude-code" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const { listCatalogNativeSlugs } = await import("../../codex/catalog");
    const { claudeCodeAlias, claudeCodeNativeAlias } = await import("../../claude/alias");
    const { buildClaudeContextWindows, effectiveModelEnv } = await import("../../claude/context-windows");
    const { visibleNativeSlugs } = await import("../../codex/catalog");
    const disabled = new Set(config.disabledModels ?? []);
    const isDisabled = (provider: string, id: string) =>
      [...disabled].some(stored => slugEquals(stored, provider, id));
    const available = [
      ...listCatalogNativeSlugs().filter(ns => !disabled.has(ns)),
      // Claude-facing values stay RAW native selectors (resolved inbound via routeModel,
      // which accepts the raw full-slash form); only the disabled check goes tolerant.
      ...models.filter(m => !isDisabled(m.provider, m.id)).map(m => `${m.provider}/${m.id}`),
    ];
    const aliases: { id: string; display_name: string }[] = [];
    for (const slug of listCatalogNativeSlugs()) {
      // Readable CLI-surface alias with hash fallback (devlog 050 / audit 051 #2) —
      // the same shared helper the /v1/models ?ids=cli path uses.
      if (!disabled.has(slug)) aliases.push({ id: claudeCodeNativeAlias(slug), display_name: `${slug} (native)` });
    }
    for (const m of models) {
      if (isDisabled(m.provider, m.id)) continue;
      aliases.push({ id: claudeCodeAlias(m.provider, m.id), display_name: `${m.id} (${m.provider})` });
    }
    const contextWindows = buildClaudeContextWindows([...visibleNativeSlugs(config)], models);
    const webSearchOverride = config.claudeCode?.webSearchSidecar;
    const visionOverride = config.claudeCode?.visionSidecar;
    return jsonResponse({
      enabled: config.claudeCode?.enabled !== false,
      // Round-trip contract with the GUI auth-mode select (devlog 260720_claude_authmode_persist):
      // absent config key = subscription (OcxClaudeCodeConfig.authMode is typed `"proxy"` only).
      authMode: config.claudeCode?.authMode === "proxy" ? "proxy" : "subscription",
      model: config.claudeCode?.model ?? "",
      smallFastModel: config.claudeCode?.smallFastModel ?? "",
      tierModels: config.claudeCode?.tierModels ?? {},
      modelMap: config.claudeCode?.modelMap ?? {},
      systemEnv: config.claudeCode?.systemEnv === true,
      autoConnectSupported: process.platform === "darwin",
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
    const body = parsedBody as { enabled?: unknown; authMode?: unknown; model?: unknown; smallFastModel?: unknown; modelMap?: unknown; systemEnv?: unknown; fastMode?: unknown; maxContextTokens?: unknown; alwaysEnableEffort?: unknown; tierModels?: unknown; autoContext?: unknown; autoCompactWindow?: unknown; blockedSkills?: unknown; injectAgents?: unknown; webSearchSidecar?: unknown; visionSidecar?: unknown };
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
    if (body.authMode !== undefined) {
      // "proxy" stores the key; "subscription" (the default) deletes it —
      // OcxClaudeCodeConfig.authMode is typed `"proxy"` only (src/types.ts).
      // Previously this field was silently dropped, so the GUI select reverted to
      // Subscription on every reload (devlog 260720_claude_authmode_persist).
      if (body.authMode !== "proxy" && body.authMode !== "subscription") {
        return jsonResponse({ error: "authMode must be \"proxy\" or \"subscription\"" }, 400);
      }
      if (body.authMode === "proxy") next.authMode = "proxy";
      else delete next.authMode;
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
    const { saveConfig: save } = await import("../../config");
    save(config);
    const warnings: string[] = [];
    // authMode changes must reconcile the injected system env too: switching back to
    // Subscription has to remove the opencodex-owned dummy ANTHROPIC_AUTH_TOKEN
    // (audit R1 blocker #1/#2, devlog 260720_claude_authmode_persist).
    if (body.systemEnv !== undefined || body.authMode !== undefined) {
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
  return null;
}
