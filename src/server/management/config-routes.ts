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
import { isStreamMode } from "../../lib/bun-stream-caps";
import { shadowSourceModels } from "../../lib/shadow-call";
import {
  configureAppOwnedMemoryBudget,
  enforceAppOwnedMemoryBudget,
  MAX_APP_OWNED_MEMORY_BUDGET_MB,
  MIN_APP_OWNED_MEMORY_BUDGET_MB,
  resolveAppOwnedMemoryBudgetBytes,
} from "../../lib/app-owned-memory";
import { enrichProviderFromCatalog, listKeyLoginProviders } from "../../oauth/key-providers";
import { deriveProviderPresets } from "../../providers/derive";
import { providerCodexAccountMode } from "../../providers/registry";
import { routedSlug, slugEquals } from "../../providers/slug-codec";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../../providers/quota";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { clearThreadAccountMap } from "../../codex/routing";
import { primeCodexPoolQuotas } from "../../codex/auth-api";
import {
  codexAccountPickerEnabled,
  initializeDefaultCodexAccountNamespaces,
} from "../../codex/account-namespaces";
import { catalogRefreshIsPending } from "../../codex/catalog-refresh-status";
import { DEFAULT_PROVIDER_CONTEXT_CAP, globalContextCapValue, providerContextCap, providerContextCaps, setAllProviderContextCaps, setGlobalContextCapValue, setProviderContextCap } from "../../providers/context-cap";
import { resolveCodexHomeDir } from "../../codex/home";
import { readUsageEntries } from "../../usage/log";
import { getUsageDebugLogEntries } from "../../usage/debug";
import { parseRange, parseUsageSurface, summarizeUsage } from "../../usage/summary";
import { stripCodexRuntimeProviderFields } from "../../codex/auth-context";
import { getProviderRegistryEntry } from "../../providers/registry";
import { VISION_REASONING_EFFORTS, isVisionReasoningEffort } from "../../reasoning-effort";
import { normalizeVisionReasoningForModel } from "../../vision/reasoning";
import {
  findAnthropicVisionProvider,
  isValidVisionTimeoutMs,
  MAX_VISION_TIMEOUT_MS,
  MIN_VISION_TIMEOUT_MS,
  resolveEffectiveVisionModel,
  resolveMaxDescriptionsPerTurn,
  resolveVisionBackend,
  resolveVisionTimeoutMs,
} from "../../vision";
import {
  visionCandidateRows,
  visionDescriberIsProvablyBlind,
  visionDescriberRejection,
  visionModelOptionsFor,
} from "./vision-sidecar-options";
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
import { withProviderServiceTierDTO } from "./provider-capability-config";
import { applySystemEnvToggle } from "../system-env";
import { getCachedStartupHealth, invalidateStartupHealthCache } from "../startup-health-cache";
import { runWindowsTrayAction } from "../windows-tray-control";
import { runStartupInstallAction, type StartupInstallAction } from "../startup-action-control";
import { displayCodexRuntimePath, effortClampAppliesToRuntime, loadLastEffortClamp, resolveCodexRuntime } from "../../codex/runtime";

import { isPlainRecord, parseDebugLogQuery, tokPerSecondResult, unavailableCostReason, costResult, requestLogDto, stripRegistryOnlyStaticHeaders, fetchAllModels } from "./shared";
import type { MetricUnavailableReason, TokPerSecondResult, CostEstimateReason, CostResult, MetricSource } from "./shared";
import type { ManagementContext } from "./context";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";

async function sidecarVisionResponseSettings(config: OcxConfig): Promise<{
  model: string;
  reasoning: string;
  models: Awaited<ReturnType<typeof visionModelOptionsFor>>;
}> {
  const vs = config.visionSidecar ?? {};
  // Match the runtime's one selected Anthropic executor for both backend fallback
  // and catalog reachability; resolving it once prevents the two projections drifting.
  const anthropicSidecar = findAnthropicVisionProvider(config);
  const backend = resolveVisionBackend(vs.backend, anthropicSidecar);
  const model = resolveEffectiveVisionModel(config, backend);
  const reasoning = normalizeVisionReasoningForModel(model, vs.reasoning) ?? "low";
  const models = await visionModelOptionsFor(config, anthropicSidecar);
  // Display-only grandfather: a persisted id stays selectable, but the write gate
  // remains stricter and rejects a model that is positively proven blind.
  if (!models.some(option => option.value === model)) {
    models.unshift({ value: model, label: model, backend });
  }
  return { model, reasoning, models };
}

function publicVisionSidecarSettings(
  config: OcxConfig,
  vision: Awaited<ReturnType<typeof sidecarVisionResponseSettings>>,
) {
  const vs = config.visionSidecar ?? {};
  return {
    enabled: vs.enabled !== false,
    model: vision.model,
    backend: vs.backend,
    reasoning: vision.reasoning,
    maxDescriptionsPerTurn: resolveMaxDescriptionsPerTurn(vs.maxDescriptionsPerTurn),
    timeoutMs: resolveVisionTimeoutMs(vs.timeoutMs),
  };
}

export async function handleConfigRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps, convergeCodexCatalog, syncClaudeAgentDefsBestEffort } = ctx;
  const readStartupHealth = deps.getCachedStartupHealth ?? getCachedStartupHealth;
  if (url.pathname === "/api/config" && req.method === "GET") {
    return jsonResponse(withProviderServiceTierDTO(safeConfigDTO(config), config));
  }

  if (url.pathname === "/api/config" && req.method === "PUT") {
    return jsonResponse({ error: "Full config PUT is disabled. Use /api/providers POST for provider changes." }, 405);
  }

  if (url.pathname === "/api/settings" && req.method === "GET") {
    let resolved: ReturnType<typeof resolveCodexRuntime>;
    try {
      // Full alternative discovery (memoized) so newerAvailable warnings work.
      resolved = resolveCodexRuntime();
    } catch {
      resolved = {
        runtime: { command: "codex", version: null, source: "fallback" },
        failures: [],
      };
    }
    const lastClamp = loadLastEffortClamp();
    const clampActive = effortClampAppliesToRuntime(lastClamp, resolved.runtime);
    const warningParts: string[] = [];
    if (resolved.replacedConfigured) {
      warningParts.push(
        `Preferred Codex runtime is unavailable; using ${displayCodexRuntimePath(resolved.runtime.command)} instead.`,
      );
    } else if (
      resolved.runtime.source === "fallback"
      && resolved.failures.length > 0
      && !resolved.runtime.version
    ) {
      warningParts.push("No validated Codex runtime found; falling back to `codex`.");
    }
    if (clampActive) {
      const clampVersion = lastClamp?.runtimeVersion ?? resolved.runtime.version ?? "an older binary";
      warningParts.push(
        `Some reasoning effort options were hidden because OpenCodex used Codex ${clampVersion}.${resolved.newerAvailable ? " A newer Codex installation is available." : ""}`,
      );
    } else if (resolved.newerAvailable) {
      warningParts.push(
        `OpenCodex is using an older Codex binary (${resolved.runtime.version ?? "unknown"}). A newer Codex installation is available.`,
      );
    }
    return jsonResponse({
      // The dashboard renders request-log timestamps. Without this it formats them in the
      // BROWSER's zone, so a KST proxy viewed from a UTC browser reports every request nine
      // hours off (#725). Carried on settings rather than /api/logs because that route's
      // array response has four consumers that would have to change with it.
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      codexAutoStart: codexAutoStartEnabled(config),
      port: config.port,
      hostname: config.hostname ?? "127.0.0.1",
      streamMode: config.streamMode ?? "auto",
      appOwnedMemoryBudgetMb: config.appOwnedMemoryBudgetMb ?? 256,
      codexAccountPickerEnabled: codexAccountPickerEnabled(config),
      startupHealth: await readStartupHealth(config),
      codexRuntime: {
        path: displayCodexRuntimePath(resolved.runtime.command),
        version: resolved.runtime.version,
        source: resolved.runtime.source,
        newerAvailable: resolved.newerAvailable
          ? {
            path: displayCodexRuntimePath(resolved.newerAvailable.command),
            version: resolved.newerAvailable.version,
          }
          : null,
        catalogClamp: {
          active: clampActive,
          removedEfforts: clampActive ? (lastClamp?.removedEfforts ?? []) : [],
          runtimeVersion: clampActive ? (lastClamp?.runtimeVersion ?? null) : null,
        },
        warning: warningParts.length > 0 ? warningParts.join(" ") : null,
      },
    });
  }

  if (url.pathname === "/api/startup-health" && req.method === "GET") {
    return jsonResponse(await readStartupHealth(config));
  }

  if (url.pathname === "/api/startup-action" && req.method === "POST") {
    let body: { action?: unknown; repair?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!body || !["install-service", "install-shim"].includes(String(body.action))) {
      return jsonResponse({ error: "action must be install-service or install-shim" }, 400);
    }
    if (body.repair !== undefined && typeof body.repair !== "boolean") {
      return jsonResponse({ error: "repair must be a boolean when provided" }, 400);
    }
    try {
      const action = body.action as StartupInstallAction;
      const repair = body.repair === true;
      const result = await (deps.runStartupInstallAction ?? runStartupInstallAction)(action, { repair });
      invalidateStartupHealthCache();
      return jsonResponse({ ok: true, action, repair, message: result.message });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  if (url.pathname === "/api/windows-tray" && req.method === "GET") {
    if (process.platform !== "win32") return jsonResponse({ supported: false, installed: false, running: false, stale: false, summary: `unsupported on ${process.platform}` });
    try {
      return jsonResponse(await runWindowsTrayAction("status"));
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  if (url.pathname === "/api/windows-tray" && req.method === "POST") {
    let body: { action?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!body || !["install", "start", "stop", "uninstall"].includes(String(body.action))) {
      return jsonResponse({ error: "action must be install, start, stop, or uninstall" }, 400);
    }
    if (process.platform !== "win32") return jsonResponse({ error: "Windows tray is only supported on Windows" }, 400);
    try {
      const status = await runWindowsTrayAction(body.action as "install" | "start" | "stop" | "uninstall");
      return jsonResponse({ ok: true, status });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  if (url.pathname === "/api/settings" && req.method === "PUT") {
    // Each field is optional but at least one must be present; fields are
    // validated when present. streamMode-only PUTs must work: Windows/macOS
    // memory troubleshooting can use this persisted stream-shape escape hatch
    // (a Windows service does not inherit shell env). A stream-shape
    // change applies to NEW turns only — the config object is shared by
    // reference with the request handlers, no restart needed.
    let parsedBody: unknown;
    try { parsedBody = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(parsedBody)) return jsonResponse({ error: "settings body must be an object" }, 400);
    const body = parsedBody as {
      codexAutoStart?: unknown;
      streamMode?: unknown;
      appOwnedMemoryBudgetMb?: unknown;
      codexAccountPickerEnabled?: unknown;
    };
    if (body.codexAutoStart === undefined
      && body.streamMode === undefined
      && body.appOwnedMemoryBudgetMb === undefined
      && body.codexAccountPickerEnabled === undefined) {
      return jsonResponse({ error: "provide codexAutoStart, streamMode, appOwnedMemoryBudgetMb, or codexAccountPickerEnabled" }, 400);
    }
    if (body.codexAutoStart !== undefined && typeof body.codexAutoStart !== "boolean") {
      return jsonResponse({ error: "codexAutoStart boolean is required" }, 400);
    }
    if (body.streamMode !== undefined && !isStreamMode(body.streamMode)) {
      return jsonResponse({ error: "streamMode must be auto, legacy-tee, or eager-relay" }, 400);
    }
    if (body.codexAccountPickerEnabled !== undefined
      && typeof body.codexAccountPickerEnabled !== "boolean") {
      return jsonResponse({ error: "codexAccountPickerEnabled boolean is required" }, 400);
    }
    if (body.appOwnedMemoryBudgetMb !== undefined && (
      typeof body.appOwnedMemoryBudgetMb !== "number"
      || !Number.isInteger(body.appOwnedMemoryBudgetMb)
      || body.appOwnedMemoryBudgetMb < MIN_APP_OWNED_MEMORY_BUDGET_MB
      || body.appOwnedMemoryBudgetMb > MAX_APP_OWNED_MEMORY_BUDGET_MB
    )) {
      return jsonResponse({ error: `appOwnedMemoryBudgetMb must be an integer from ${MIN_APP_OWNED_MEMORY_BUDGET_MB} to ${MAX_APP_OWNED_MEMORY_BUDGET_MB}` }, 400);
    }
    const previousSettings = {
      codexAutoStart: config.codexAutoStart,
      hasCodexAutoStart: Object.hasOwn(config, "codexAutoStart"),
      streamMode: config.streamMode,
      hasStreamMode: Object.hasOwn(config, "streamMode"),
      appOwnedMemoryBudgetMb: config.appOwnedMemoryBudgetMb,
      hasAppOwnedMemoryBudgetMb: Object.hasOwn(config, "appOwnedMemoryBudgetMb"),
      codexAccountNamespaces: config.codexAccountNamespaces,
      hasCodexAccountNamespaces: Object.hasOwn(config, "codexAccountNamespaces"),
      codexAccountPickerEnabled: config.codexAccountPickerEnabled,
      hasCodexAccountPickerEnabled: Object.hasOwn(config, "codexAccountPickerEnabled"),
    };
    const pickerWasEnabled = codexAccountPickerEnabled(config);
    let pickerIsEnabled = pickerWasEnabled;
    try {
      if (typeof body.codexAutoStart === "boolean") {
        config.codexAutoStart = body.codexAutoStart;
      }
      if (body.streamMode !== undefined) {
        if (body.streamMode === "auto") {
          delete config.streamMode;
        } else {
          config.streamMode = body.streamMode as "legacy-tee" | "eager-relay";
        }
      }
      if (typeof body.appOwnedMemoryBudgetMb === "number") {
        config.appOwnedMemoryBudgetMb = body.appOwnedMemoryBudgetMb;
      }
      if (body.codexAccountPickerEnabled === true) {
        config.codexAccountPickerEnabled = true;
        initializeDefaultCodexAccountNamespaces(config);
      } else if (body.codexAccountPickerEnabled === false) {
        config.codexAccountPickerEnabled = false;
      }
      pickerIsEnabled = codexAccountPickerEnabled(config);
      (deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode)(config);
    } catch (error) {
      if (previousSettings.hasCodexAutoStart) config.codexAutoStart = previousSettings.codexAutoStart;
      else delete config.codexAutoStart;
      if (previousSettings.hasStreamMode) config.streamMode = previousSettings.streamMode;
      else delete config.streamMode;
      if (previousSettings.hasAppOwnedMemoryBudgetMb) {
        config.appOwnedMemoryBudgetMb = previousSettings.appOwnedMemoryBudgetMb;
      } else delete config.appOwnedMemoryBudgetMb;
      if (previousSettings.hasCodexAccountNamespaces) {
        config.codexAccountNamespaces = previousSettings.codexAccountNamespaces;
      } else delete config.codexAccountNamespaces;
      if (previousSettings.hasCodexAccountPickerEnabled) {
        config.codexAccountPickerEnabled = previousSettings.codexAccountPickerEnabled;
      } else delete config.codexAccountPickerEnabled;
      throw error;
    }
    if (typeof body.appOwnedMemoryBudgetMb === "number") {
      configureAppOwnedMemoryBudget(resolveAppOwnedMemoryBudgetBytes(body.appOwnedMemoryBudgetMb));
      enforceAppOwnedMemoryBudget();
    }
    const catalogRefresh = pickerWasEnabled !== pickerIsEnabled
      ? await convergeCodexCatalog()
      : undefined;
    const catalogRefreshPending = catalogRefresh
      ? catalogRefreshIsPending(catalogRefresh)
      : false;
    invalidateStartupHealthCache();
    return jsonResponse({
      ok: true,
      codexAutoStart: codexAutoStartEnabled(config),
      streamMode: config.streamMode ?? "auto",
      appOwnedMemoryBudgetMb: config.appOwnedMemoryBudgetMb ?? 256,
      codexAccountPickerEnabled: pickerIsEnabled,
      catalogRefreshPending,
      startupHealth: await readStartupHealth(config),
    });
  }

  if (url.pathname === "/api/diagnostics/project-config" && req.method === "GET") {
    const { getCachedProjectConfigDiagnostics } = await import("../../codex/project-config-warnings");
    const { warnings, grouped } = getCachedProjectConfigDiagnostics();
    return jsonResponse({ warnings, grouped });
  }

  if (url.pathname === "/api/sync" && req.method === "POST") {
    const { syncModelsToCodex } = await import("../../codex/sync");
    const { attachStaleAppServerHint } = await import("../../codex/app-server-processes");
    const { readRuntimePort, loadConfig } = await import("../../config");
    // Never use the server-captured startup object for a durable integration
    // decision. A toggle may have persisted while this process was gathering.
    const runtime = readRuntimePort(process.pid);
    const result = await syncModelsToCodex(runtime?.port, loadConfig(), null);
    const status = result.status === "refused" ? 409 : (result.status === "skipped" || result.ok ? 200 : 500);
    return jsonResponse({
      ...attachStaleAppServerHint(result),
      ...(result.ok ? {} : { error: result.message }),
    }, status);
  }

  if (url.pathname === "/api/update/check" && req.method === "GET") {
    const { checkForUpdate, normalizeUpdateChannel } = await import("../../update/job");
    const rawTag = url.searchParams.get("tag");
    if (rawTag && rawTag !== "latest" && rawTag !== "preview") {
      return jsonResponse({ error: "tag must be latest or preview" }, 400);
    }
    return jsonResponse(checkForUpdate(normalizeUpdateChannel(rawTag)));
  }

  if (url.pathname === "/api/update/run" && req.method === "POST") {
    const { normalizeUpdateChannel, startUpdateJob, UpdateJobError } = await import("../../update/job");
    let body: { tag?: unknown; restart?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
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
    const { readUpdateJob } = await import("../../update/job");
    const job = readUpdateJob(url.searchParams.get("jobId"));
    if (!job) return jsonResponse({ error: "update job not found" }, 404);
    return jsonResponse({ ok: true, job });
  }

  if (url.pathname === "/api/sidecar-settings" && req.method === "GET") {
    const ws = config.webSearchSidecar ?? {};
    const vision = await sidecarVisionResponseSettings(config);
    return jsonResponse({
      webSearch: {
        model: ws.model ?? "gpt-5.6-luna",
        backend: ws.backend,
        provider: ws.provider,
        streamRoutedModelOutput: ws.streamRoutedModelOutput === true,
      },
      vision: publicVisionSidecarSettings(config, vision),
      visionModels: vision.models,
    });
  }

  if (url.pathname === "/api/sidecar-settings" && req.method === "PUT") {
    let raw: unknown;
    try { raw = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    // Strict shape (review F2): reject non-object bodies and non-object sections instead of throwing
    // on `null` or silently accepting arrays/strings as no-op updates.
    if (!isPlainRecord(raw)) return jsonResponse({ error: "body must be a JSON object" }, 400);
    if (raw.webSearch !== undefined && !isPlainRecord(raw.webSearch)) return jsonResponse({ error: "webSearch must be an object" }, 400);
    if (raw.vision !== undefined && !isPlainRecord(raw.vision)) return jsonResponse({ error: "vision must be an object" }, 400);
    const body = raw as {
      webSearch?: { model?: unknown; backend?: unknown; provider?: unknown; reasoning?: unknown; streamRoutedModelOutput?: unknown };
      vision?: {
        model?: unknown;
        backend?: unknown;
        reasoning?: unknown;
        maxDescriptionsPerTurn?: unknown;
        enabled?: unknown;
        timeoutMs?: unknown;
      };
    };
    if (body.webSearch && body.webSearch.backend !== undefined && body.webSearch.backend !== null
      && body.webSearch.backend !== "openai" && body.webSearch.backend !== "anthropic") {
      return jsonResponse({ error: "webSearch.backend must be openai, anthropic, keyed, or null" }, 400);
    }
    if (body.webSearch && body.webSearch.provider !== undefined && body.webSearch.provider !== null
      && (typeof body.webSearch.provider !== "string" || body.webSearch.provider.trim() === "")) {
      return jsonResponse({ error: "webSearch.provider must be a nonblank provider name" }, 400);
    }
    if (body.webSearch && body.webSearch.streamRoutedModelOutput !== undefined
      && typeof body.webSearch.streamRoutedModelOutput !== "boolean") {
      return jsonResponse({ error: "webSearch.streamRoutedModelOutput must be a boolean" }, 400);
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
    if (body.vision && body.vision.enabled !== undefined && typeof body.vision.enabled !== "boolean") {
      return jsonResponse({ error: "vision.enabled must be a boolean" }, 400);
    }
    if (body.vision && body.vision.timeoutMs !== undefined && !isValidVisionTimeoutMs(body.vision.timeoutMs)) {
      return jsonResponse({
        error: `vision.timeoutMs must be an integer from ${MIN_VISION_TIMEOUT_MS} to ${MAX_VISION_TIMEOUT_MS}`,
      }, 400);
    }
    if (body.vision?.reasoning !== undefined && !isVisionReasoningEffort(body.vision.reasoning)) {
      return jsonResponse({ error: `vision.reasoning must be ${VISION_REASONING_EFFORTS.join(", ")}` }, 400);
    }
    // Reject ONLY a model we can prove is blind. An id nothing knows about stays
    // allowed: the operator may be ahead of our catalog, and the runtime never
    // required catalog membership (`tests/vision-reasoning-contract.test.ts`
    // pins `custom-vision` → 200). The catalog is read ONCE and reused for the
    // rejection body, so a 400 cannot cost two provider fetches.
    if (body.vision && typeof body.vision.model === "string" && body.vision.model !== "") {
      const requested = body.vision.model;
      const candidates = await visionCandidateRows(config);
      const hint = body.vision.backend === "anthropic" || body.vision.backend === "openai"
        ? body.vision.backend
        : config.visionSidecar?.backend;
      if (visionDescriberIsProvablyBlind(config, requested, candidates, hint)) {
        return jsonResponse(visionDescriberRejection("vision.model", requested, config, candidates), 400);
      }
    }

    let normalizedVisionReasoning: ReturnType<typeof normalizeVisionReasoningForModel>;
    let visionReasoningTouched = false;
    if (body.vision && (body.vision.model !== undefined || body.vision.reasoning !== undefined)) {
      visionReasoningTouched = true;
      const model = typeof body.vision.model === "string"
        ? (body.vision.model === "" ? "gpt-5.4-mini" : body.vision.model)
        : (config.visionSidecar?.model || "gpt-5.4-mini");
      const sourceReasoning = body.vision.reasoning ?? config.visionSidecar?.reasoning;
      normalizedVisionReasoning = sourceReasoning === undefined
        ? undefined
        : normalizeVisionReasoningForModel(model, sourceReasoning);
    }

    if (body.webSearch) {
      config.webSearchSidecar = { ...config.webSearchSidecar };
      if (typeof body.webSearch.model === "string") {
        if (body.webSearch.model === "") delete config.webSearchSidecar.model;
        else config.webSearchSidecar.model = body.webSearch.model;
      }
      if (body.webSearch.backend === null) delete config.webSearchSidecar.backend;
      else if (
        body.webSearch.backend === "openai"
        || body.webSearch.backend === "anthropic"
        || body.webSearch.backend === "keyed"
      ) {
        config.webSearchSidecar.backend = body.webSearch.backend;
      }
      if (body.webSearch.provider === null || body.webSearch.provider === "") {
        delete config.webSearchSidecar.provider;
      } else if (typeof body.webSearch.provider === "string") {
        config.webSearchSidecar.provider = body.webSearch.provider;
      }
      if (typeof body.webSearch.reasoning === "string") config.webSearchSidecar.reasoning = body.webSearch.reasoning;
      if (typeof body.webSearch.streamRoutedModelOutput === "boolean") {
        // `false` is the default — drop the key so config files stay minimal.
        if (body.webSearch.streamRoutedModelOutput) config.webSearchSidecar.streamRoutedModelOutput = true;
        else delete config.webSearchSidecar.streamRoutedModelOutput;
      }
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
      if (typeof body.vision.enabled === "boolean") {
        // `true` is the default — drop the key so disable/re-enable does not rewrite the file.
        if (body.vision.enabled) delete config.visionSidecar.enabled;
        else config.visionSidecar.enabled = false;
      }
      if (typeof body.vision.timeoutMs === "number") {
        config.visionSidecar.timeoutMs = body.vision.timeoutMs;
      }
      if (visionReasoningTouched) {
        if (normalizedVisionReasoning === undefined) delete config.visionSidecar.reasoning;
        else config.visionSidecar.reasoning = normalizedVisionReasoning;
      }
    }
    saveConfigPreservingClaudeCode(config);
    const ws = config.webSearchSidecar ?? {};
    const vision = await sidecarVisionResponseSettings(config);
    return jsonResponse({
      ok: true,
      webSearch: {
        model: ws.model ?? "gpt-5.6-luna",
        backend: ws.backend,
        provider: ws.provider,
        streamRoutedModelOutput: ws.streamRoutedModelOutput === true,
      },
      vision: publicVisionSidecarSettings(config, vision),
      visionModels: vision.models,
    });
  }

  if (url.pathname === "/api/shadow-call-settings" && req.method === "GET") {
    const sci = config.shadowCallIntercept ?? {};
    return jsonResponse({
      enabled: sci.enabled === true,
      model: sci.model ?? "",
      sourceModels: shadowSourceModels(sci.sourceModels),
    });
  }

  if (url.pathname === "/api/shadow-call-settings" && req.method === "PUT") {
    let raw: unknown;
    try { raw = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
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
    saveConfigPreservingClaudeCode(config);
    const sci = config.shadowCallIntercept;
    return jsonResponse({
      ok: true,
      enabled: sci.enabled === true,
      model: sci.model ?? "",
      sourceModels: shadowSourceModels(sci.sourceModels),
    });
  }
  return null;
}
