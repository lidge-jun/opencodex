import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CatalogModel } from "../../codex/catalog";
import { catalogModelSlug, invalidateCodexModelsCache, nativeContextLimits, nativeModelRows, uniqueCatalogModelsForPublicList } from "../../codex/catalog";
import {
  DEFAULT_SUBAGENT_MODELS,
  codexAutoStartEnabled,
  deleteConfigTopLevelKey,
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
import {
  webSearchCandidateRows,
  webSearchModelIsRejected,
  webSearchModelOptionsFrom,
  webSearchModelRejection,
} from "./web-search-sidecar-options";
import { validateXaiSearchOptions } from "../../web-search/xai-executor";
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
import { shadowCallTargetError } from "./shadow-call-validation";
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
  // The routed backend reports its own namespaced model verbatim: it is the
  // dispatched value, and collapsing it through the legacy resolver would
  // display a describer the runtime is not using (roadmap 190).
  const routedActive = vs.backend === "routed" && !!vs.model && vs.model.includes("/");
  const backend = routedActive ? "routed" as const : resolveVisionBackend(vs.backend, anthropicSidecar);
  const model = routedActive && vs.model
    ? vs.model
    : resolveEffectiveVisionModel(config, backend === "routed" ? resolveVisionBackend(undefined, anthropicSidecar) : backend);
  const reasoning = normalizeVisionReasoningForModel(model, vs.reasoning) ?? "low";
  const models = await visionModelOptionsFor(config, anthropicSidecar);
  // Display-only grandfather: a persisted id stays selectable, but the write gate
  // remains stricter and rejects a model that is positively proven blind.
  if (!models.some(option => option.value === model)) {
    models.unshift({ value: model, label: model, backend });
  }
  return { model, reasoning, models };
}

/** One client's outcome from a fan-out sync. Absent from the list means "left alone". */
interface ClientIntegrationSyncOutcome {
  readonly client: "grok" | "claude-desktop" | "mcode";
  readonly ok: boolean;
  readonly changed?: boolean;
  readonly reason?: string;
}

/**
 * Re-inject native clients that are switched ON and file integrations whose
 * OpenCodex ownership record is the operator's durable opt-in.
 *
 * Only Codex used to run here, so a catalog change reached Codex and nothing else: a Grok
 * fence or a written Desktop profile kept the context windows it was created with until the
 * next `ocx start`. The startup path already gates each client on its own toggle
 * (`src/cli/index.ts`), and this is that same fan-out for the on-demand command.
 *
 * A client that is OFF or never connected is omitted from the result rather than reported as skipped — the
 * caller has to be able to tell "not touched" from "tried and failed". A client that fails
 * does not fail the sync: Codex is the one that matters for routing, and a broken Grok file
 * should surface as a warning, not as a 500 on a command that did its main job.
 */
async function syncEnabledClientIntegrations(
  port: number | undefined,
  config: OcxConfig,
): Promise<ClientIntegrationSyncOutcome[]> {
  if (port === undefined) return [];
  const { claudeDesktopIntegrationEnabled, grokIntegrationEnabled } = await import("../../codex/desired-state");
  const out: ClientIntegrationSyncOutcome[] = [];

  if (grokIntegrationEnabled(config)) {
    try {
      const { syncGrokConfig } = await import("../../grok/sync");
      const r = await syncGrokConfig(port, config, config.hostname ? { hostname: config.hostname } : {});
      out.push(r.ok
        ? { client: "grok", ok: true, changed: r.changed === true }
        : { client: "grok", ok: false, reason: r.message });
    } catch (error) {
      out.push({ client: "grok", ok: false, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  if (claudeDesktopIntegrationEnabled(config)) {
    try {
      const { writeDesktop3pConfig } = await import("../../claude/desktop-3p");
      const { desktopVisibleNativeSlugs, filterCatalogVisibleModels } = await import("../../codex/catalog");
      const { fetchAllModels } = await import("../management-api");
      const routed = filterCatalogVisibleModels(await fetchAllModels(config), config)
        .map(model => ({ provider: model.provider, id: model.id, contextWindow: model.contextWindow }));
      const r = writeDesktop3pConfig(
        port,
        [...desktopVisibleNativeSlugs(config)],
        routed,
        config.apiKeys?.[0]?.key,
        "static",
        config.claudeCode?.desktopProfile,
        nativeContextLimits(config),
      );
      out.push(r.written
        ? { client: "claude-desktop", ok: true, changed: true }
        : { client: "claude-desktop", ok: false, reason: r.reason ?? "Claude Desktop write failed" });
    } catch (error) {
      out.push({ client: "claude-desktop", ok: false, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  try {
    const { refreshOwnedIntegration } = await import("../../integrations/owned-refresh");
    const result = await refreshOwnedIntegration({
      clientId: "mcode",
      models: async () => {
        const { loadExportModels } = await import("./model-rows");
        return loadExportModels(config);
      },
      config,
      port,
    });
    if (result) {
      out.push(result.ok
        ? {
            client: "mcode",
            ok: true,
            changed: result.changed === true,
            ...(result.reason ? { reason: result.reason } : {}),
          }
        : { client: "mcode", ok: false, reason: result.reason });
    }
  } catch (error) {
    out.push({ client: "mcode", ok: false, reason: error instanceof Error ? error.message : String(error) });
  }

  return out;
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
      // Absent means hidden, so the GUI renders the switch without having to know that
      // `undefined` and `false` mean the same thing.
      showCodexSparkQuota: config.showCodexSparkQuota === true,
      // Absent means the historical auto-open, so the GUI can render the toggle
      // without having to know that `undefined` and `true` mean the same thing.
      oauthOpenBrowser: config.oauthOpenBrowser !== false,
      // Absent means off (today's Design B injection), so the GUI/CLI render a plain switch.
      codexDesktopAuthless: config.codexDesktopAuthless === true,
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
      oauthOpenBrowser?: unknown;
      showCodexSparkQuota?: unknown;
      codexDesktopAuthless?: unknown;
    };
    if (body.codexAutoStart === undefined
      && body.streamMode === undefined
      && body.appOwnedMemoryBudgetMb === undefined
      && body.codexAccountPickerEnabled === undefined
      && body.oauthOpenBrowser === undefined
      && body.showCodexSparkQuota === undefined
      && body.codexDesktopAuthless === undefined) {
      return jsonResponse({ error: "provide codexAutoStart, streamMode, appOwnedMemoryBudgetMb, codexAccountPickerEnabled, oauthOpenBrowser, showCodexSparkQuota, or codexDesktopAuthless" }, 400);
    }
    if (body.codexAutoStart !== undefined && typeof body.codexAutoStart !== "boolean") {
      return jsonResponse({ error: "codexAutoStart boolean is required" }, 400);
    }
    if (body.oauthOpenBrowser !== undefined && typeof body.oauthOpenBrowser !== "boolean") {
      return jsonResponse({ error: "oauthOpenBrowser boolean is required" }, 400);
    }
    if (body.streamMode !== undefined && !isStreamMode(body.streamMode)) {
      return jsonResponse({ error: "streamMode must be auto, legacy-tee, or eager-relay" }, 400);
    }
    if (body.codexAccountPickerEnabled !== undefined
      && typeof body.codexAccountPickerEnabled !== "boolean") {
      return jsonResponse({ error: "codexAccountPickerEnabled boolean is required" }, 400);
    }
    if (body.showCodexSparkQuota !== undefined && typeof body.showCodexSparkQuota !== "boolean") {
      return jsonResponse({ error: "showCodexSparkQuota boolean is required" }, 400);
    }
    if (body.codexDesktopAuthless !== undefined && typeof body.codexDesktopAuthless !== "boolean") {
      return jsonResponse({ error: "codexDesktopAuthless boolean is required" }, 400);
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
      oauthOpenBrowser: config.oauthOpenBrowser,
      hasOauthOpenBrowser: Object.hasOwn(config, "oauthOpenBrowser"),
      showCodexSparkQuota: config.showCodexSparkQuota,
      hasShowCodexSparkQuota: Object.hasOwn(config, "showCodexSparkQuota"),
      codexDesktopAuthless: config.codexDesktopAuthless,
      hasCodexDesktopAuthless: Object.hasOwn(config, "codexDesktopAuthless"),
    };
    const pickerWasEnabled = codexAccountPickerEnabled(config);
    let pickerIsEnabled = pickerWasEnabled;
    const authlessWasEnabled = config.codexDesktopAuthless === true;
    try {
      if (typeof body.codexAutoStart === "boolean") {
        config.codexAutoStart = body.codexAutoStart;
      }
      if (body.streamMode !== undefined) {
        if (body.streamMode === "auto") {
          deleteConfigTopLevelKey(config, "streamMode");
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
      if (typeof body.oauthOpenBrowser === "boolean") {
        config.oauthOpenBrowser = body.oauthOpenBrowser;
      }
      if (typeof body.showCodexSparkQuota === "boolean") {
        config.showCodexSparkQuota = body.showCodexSparkQuota;
      }
      if (body.codexDesktopAuthless === true) config.codexDesktopAuthless = true;
      else if (body.codexDesktopAuthless === false) deleteConfigTopLevelKey(config, "codexDesktopAuthless");
      pickerIsEnabled = codexAccountPickerEnabled(config);
      (deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode)(config);
    } catch (error) {
      if (previousSettings.hasCodexAutoStart) config.codexAutoStart = previousSettings.codexAutoStart;
      else deleteConfigTopLevelKey(config, "codexAutoStart");
      if (previousSettings.hasStreamMode) config.streamMode = previousSettings.streamMode;
      else deleteConfigTopLevelKey(config, "streamMode");
      if (previousSettings.hasAppOwnedMemoryBudgetMb) {
        config.appOwnedMemoryBudgetMb = previousSettings.appOwnedMemoryBudgetMb;
      } else deleteConfigTopLevelKey(config, "appOwnedMemoryBudgetMb");
      if (previousSettings.hasCodexAccountNamespaces) {
        config.codexAccountNamespaces = previousSettings.codexAccountNamespaces;
      } else deleteConfigTopLevelKey(config, "codexAccountNamespaces");
      if (previousSettings.hasCodexAccountPickerEnabled) {
        config.codexAccountPickerEnabled = previousSettings.codexAccountPickerEnabled;
      } else deleteConfigTopLevelKey(config, "codexAccountPickerEnabled");
      if (previousSettings.hasOauthOpenBrowser) {
        config.oauthOpenBrowser = previousSettings.oauthOpenBrowser;
      } else deleteConfigTopLevelKey(config, "oauthOpenBrowser");
      if (previousSettings.hasShowCodexSparkQuota) {
        config.showCodexSparkQuota = previousSettings.showCodexSparkQuota;
      } else deleteConfigTopLevelKey(config, "showCodexSparkQuota");
      if (previousSettings.hasCodexDesktopAuthless) {
        config.codexDesktopAuthless = previousSettings.codexDesktopAuthless;
      } else deleteConfigTopLevelKey(config, "codexDesktopAuthless");
      throw error;
    }
    if (typeof body.appOwnedMemoryBudgetMb === "number") {
      configureAppOwnedMemoryBudget(resolveAppOwnedMemoryBudgetBytes(body.appOwnedMemoryBudgetMb));
      enforceAppOwnedMemoryBudget();
    }
    // The authless switch changes the injected config.toml shape, so converge now rather than
    // waiting for the next start; the injector re-reads config and rewrites the form.
    const authlessIsEnabled = config.codexDesktopAuthless === true;
    const catalogRefresh = pickerWasEnabled !== pickerIsEnabled || authlessWasEnabled !== authlessIsEnabled
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
      oauthOpenBrowser: config.oauthOpenBrowser !== false,
      catalogRefreshPending,
      showCodexSparkQuota: config.showCodexSparkQuota === true,
      codexDesktopAuthless: authlessIsEnabled,
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
    const [{ readRuntimePort }, { loadConfig }] = await Promise.all([
      import("../../config/process-state"),
      import("../../config"),
    ]);
    // Never use the server-captured startup object for a durable integration
    // decision. A toggle may have persisted while this process was gathering.
    const runtime = readRuntimePort(process.pid);
    const config = loadConfig();
    const result = await syncModelsToCodex(runtime?.port, config, null);
    // A sync used to stop here, so a Grok fence or a Desktop profile kept whatever
    // context windows it was written with while the Codex catalog moved on. The
    // startup path already fans out to every enabled client; this is the same fan-out
    // for the on-demand command. Codex goes first because the others read its catalog.
    const integrations = result.status === "refused"
      ? []
      : await syncEnabledClientIntegrations(runtime?.port, config);
    const status = result.status === "refused" ? 409 : (result.status === "skipped" || result.ok ? 200 : 500);
    return jsonResponse({
      ...attachStaleAppServerHint(result),
      ...(integrations.length > 0 ? { integrations } : {}),
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
    const webSearchCandidates = await webSearchCandidateRows(config);
    return jsonResponse({
      webSearch: {
        model: ws.model ?? "gpt-5.6-luna",
        backend: ws.backend,
        streamRoutedModelOutput: ws.streamRoutedModelOutput === true,
        ...(ws.xSearch ? { xSearch: ws.xSearch } : {}),
      },
      vision: publicVisionSidecarSettings(config, vision),
      visionModels: vision.models,
      // ALWAYS present: the dashboard treats an omitted list as "no filter" and
      // falls back to the full model union, so empty must be [] (review B3).
      webSearchModels: webSearchModelOptionsFrom(config, webSearchCandidates),
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
      webSearch?: { model?: unknown; backend?: unknown; reasoning?: unknown; streamRoutedModelOutput?: unknown; exaApiKey?: unknown; xSearch?: unknown };
      vision?: {
        model?: unknown;
        backend?: unknown;
        reasoning?: unknown;
        maxDescriptionsPerTurn?: unknown;
        enabled?: unknown;
        timeoutMs?: unknown;
      };
    };
    const WEB_SEARCH_BACKENDS_UNION = ["openai", "anthropic", "xai", "gemini", "exa"] as const;
    if (body.webSearch && body.webSearch.backend !== undefined && body.webSearch.backend !== null
      && !WEB_SEARCH_BACKENDS_UNION.includes(body.webSearch.backend as never)) {
      return jsonResponse({ error: "webSearch.backend must be openai, anthropic, xai, gemini, exa, or null" }, 400);
    }
    if (body.webSearch?.model !== undefined && typeof body.webSearch.model !== "string") {
      return jsonResponse({ error: "webSearch.model must be a string" }, 400);
    }
    if (body.webSearch && body.webSearch.streamRoutedModelOutput !== undefined
      && typeof body.webSearch.streamRoutedModelOutput !== "boolean") {
      return jsonResponse({ error: "webSearch.streamRoutedModelOutput must be a boolean" }, 400);
    }
    if (body.vision && body.vision.backend !== undefined
      && body.vision.backend !== null && body.vision.backend !== "openai" && body.vision.backend !== "anthropic"
      && body.vision.backend !== "routed") {
      return jsonResponse({ error: "vision.backend must be openai, anthropic, routed, or null" }, 400);
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
        || body.vision.backend === "routed"
        ? body.vision.backend
        : config.visionSidecar?.backend;
      // Coherence (roadmap 170 r2): the forward/OAuth executors POST the model
      // string VERBATIM, so a namespaced id on those backends persists a wire
      // id they cannot run; and "routed" without a namespace cannot route.
      const effectiveBackend = hint ?? "openai";
      const namespaced = requested.includes("/");
      if (namespaced && effectiveBackend !== "routed") {
        return jsonResponse({ error: `vision.model "${requested}" is provider-namespaced; it requires vision.backend "routed"` }, 400);
      }
      if (!namespaced && effectiveBackend === "routed") {
        return jsonResponse({ error: `vision.backend "routed" requires a provider-namespaced vision.model ("provider/model"); got "${requested}"` }, 400);
      }
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
      const pairTouched = body.webSearch.model !== undefined || body.webSearch.backend !== undefined;
      // Validate against the backend the caller SUBMITTED, across the whole
      // union — not just openai/anthropic (#2457). The union check above has
      // already refused unknown literals, so a surviving string is a member;
      // Array.includes does not narrow, hence the cast. Falling back to the
      // stored backend for xai/gemini/exa both rejected legal pairs and
      // accepted illegal ones: a submitted gemini was checked against a stored
      // openai. null means "unset the backend", and unset resolves to openai.
      const submittedBackend = body.webSearch.backend;
      const effectiveBackend = typeof submittedBackend === "string"
        && WEB_SEARCH_BACKENDS_UNION.includes(submittedBackend as never)
        ? submittedBackend as typeof WEB_SEARCH_BACKENDS_UNION[number]
        : submittedBackend === null
          ? "openai"
          : config.webSearchSidecar?.backend ?? "openai";
      const effectiveModel = typeof body.webSearch.model === "string"
        ? body.webSearch.model || undefined
        : config.webSearchSidecar?.model;
      if (pairTouched && effectiveModel) {
        const candidates = await webSearchCandidateRows(config);
        if (webSearchModelIsRejected(effectiveBackend, effectiveModel, candidates)) {
          return jsonResponse(webSearchModelRejection("webSearch.model", effectiveBackend, effectiveModel, candidates), 400);
        }
      }
      const webSearchCandidate = { ...config.webSearchSidecar };
      if (typeof body.webSearch.model === "string") {
        if (body.webSearch.model === "") delete webSearchCandidate.model;
        else webSearchCandidate.model = body.webSearch.model;
      }
      if (body.webSearch.backend === null) delete webSearchCandidate.backend;
      else if (WEB_SEARCH_BACKENDS_UNION.includes(body.webSearch.backend as never)) {
        webSearchCandidate.backend = body.webSearch.backend as typeof WEB_SEARCH_BACKENDS_UNION[number];
      }
      if (typeof body.webSearch.reasoning === "string") webSearchCandidate.reasoning = body.webSearch.reasoning;
      // Operator secret for the exa backend: string sets, empty string clears. The GET
      // payload deliberately never carries it and redact.ts strips the key from logs.
      if (typeof body.webSearch.exaApiKey === "string") {
        if (body.webSearch.exaApiKey === "") delete webSearchCandidate.exaApiKey;
        else webSearchCandidate.exaApiKey = body.webSearch.exaApiKey;
      }
      // Opt-in x_search block (L7): null clears; an object is doc-validated before persisting.
      if (body.webSearch.xSearch === null) delete webSearchCandidate.xSearch;
      else if (body.webSearch.xSearch !== undefined) {
        if (!isPlainRecord(body.webSearch.xSearch)) {
          return jsonResponse({ error: "webSearch.xSearch must be an object or null" }, 400);
        }
        const x = body.webSearch.xSearch as Record<string, unknown>;
        const allowedXSearchKeys = new Set([
          "enabled",
          "allowedXHandles",
          "excludedXHandles",
          "fromDate",
          "toDate",
        ]);
        const unknownKey = Object.keys(x).find(key => !allowedXSearchKeys.has(key));
        if (unknownKey !== undefined) {
          return jsonResponse({ error: `webSearch.xSearch.${unknownKey} is not a supported field` }, 400);
        }
        if (x.enabled !== undefined && typeof x.enabled !== "boolean") {
          return jsonResponse({ error: "webSearch.xSearch.enabled must be a boolean" }, 400);
        }
        for (const field of ["allowedXHandles", "excludedXHandles"] as const) {
          const value = x[field];
          if (value !== undefined && (!Array.isArray(value) || !value.every(handle => typeof handle === "string"))) {
            return jsonResponse({ error: `webSearch.xSearch.${field} must be an array of strings` }, 400);
          }
        }
        for (const field of ["fromDate", "toDate"] as const) {
          if (x[field] !== undefined && typeof x[field] !== "string") {
            return jsonResponse({ error: `webSearch.xSearch.${field} must be an ISO-8601 date (YYYY-MM-DD)` }, 400);
          }
        }
        const candidate = {
          ...(x.enabled === true ? { enabled: true } : {}),
          ...(x.allowedXHandles !== undefined ? { allowedXHandles: x.allowedXHandles as string[] } : {}),
          ...(x.excludedXHandles !== undefined ? { excludedXHandles: x.excludedXHandles as string[] } : {}),
          ...(x.fromDate !== undefined ? { fromDate: x.fromDate as string } : {}),
          ...(x.toDate !== undefined ? { toDate: x.toDate as string } : {}),
        };
        const invalid = validateXaiSearchOptions({
          xSearch: candidate.enabled,
          allowedXHandles: candidate.allowedXHandles,
          excludedXHandles: candidate.excludedXHandles,
          fromDate: candidate.fromDate,
          toDate: candidate.toDate,
        });
        if (invalid) return jsonResponse({ error: `webSearch.xSearch invalid: ${invalid}` }, 400);
        webSearchCandidate.xSearch = candidate;
      }
      if (typeof body.webSearch.streamRoutedModelOutput === "boolean") {
        // `false` is the default — drop the key so config files stay minimal.
        if (body.webSearch.streamRoutedModelOutput) webSearchCandidate.streamRoutedModelOutput = true;
        else delete webSearchCandidate.streamRoutedModelOutput;
      }
      config.webSearchSidecar = webSearchCandidate;
    }
    if (body.vision) {
      config.visionSidecar = { ...config.visionSidecar };
      if (typeof body.vision.model === "string") {
        if (body.vision.model === "") delete config.visionSidecar.model;
        else config.visionSidecar.model = body.vision.model;
      }
      if (body.vision.backend === null) delete config.visionSidecar.backend;
      else if (body.vision.backend === "openai" || body.vision.backend === "anthropic"
        || body.vision.backend === "routed") {
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
    const savedWebSearchCandidates = await webSearchCandidateRows(config);
    return jsonResponse({
      ok: true,
      webSearch: {
        model: ws.model ?? "gpt-5.6-luna",
        backend: ws.backend,
        streamRoutedModelOutput: ws.streamRoutedModelOutput === true,
        ...(ws.xSearch ? { xSearch: ws.xSearch } : {}),
      },
      vision: publicVisionSidecarSettings(config, vision),
      visionModels: vision.models,
      // Echoed for the same reason GET always carries it: the dashboard rebuilds
      // its sidecar state from this body, and an omitted key reads as "old
      // server" and falls back to the full union (review F1).
      webSearchModels: webSearchModelOptionsFrom(config, savedWebSearchCandidates),
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
    const candidateModel = typeof body.model === "string"
      ? body.model
      : body.enabled === true
        ? config.shadowCallIntercept?.model
        : undefined;
    const targetError = shadowCallTargetError(config, candidateModel);
    if (targetError) return jsonResponse({ error: targetError }, 400);
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
