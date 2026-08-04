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
import { getCachedStartupHealth, invalidateStartupHealthCache } from "../startup-health-cache";
import { runWindowsTrayAction } from "../windows-tray-control";
import { runStartupInstallAction, type StartupInstallAction } from "../startup-action-control";

import { isPlainRecord, parseDebugLogQuery, tokPerSecondResult, unavailableCostReason, costResult, requestLogDto, stripRegistryOnlyStaticHeaders, fetchAllModels } from "./shared";
import type { MetricUnavailableReason, TokPerSecondResult, CostEstimateReason, CostResult, MetricSource } from "./shared";
import type { ManagementContext } from "./context";

export async function handleConfigRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps, refreshCodexCatalogBestEffort, syncClaudeAgentDefsBestEffort } = ctx;
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
      startupHealth: await getCachedStartupHealth(config),
    });
  }

  if (url.pathname === "/api/startup-health" && req.method === "GET") {
    return jsonResponse(await getCachedStartupHealth(config));
  }

  if (url.pathname === "/api/startup-action" && req.method === "POST") {
    let body: { action?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!body || !["install-service", "install-shim"].includes(String(body.action))) {
      return jsonResponse({ error: "action must be install-service or install-shim" }, 400);
    }
    try {
      const action = body.action as StartupInstallAction;
      const result = await (deps.runStartupInstallAction ?? runStartupInstallAction)(action);
      invalidateStartupHealthCache();
      return jsonResponse({ ok: true, action, message: result.message });
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
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
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
    let body: { codexAutoStart?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (typeof body.codexAutoStart !== "boolean") {
      return jsonResponse({ error: "codexAutoStart boolean is required" }, 400);
    }
    config.codexAutoStart = body.codexAutoStart;
    saveConfig(config);
    invalidateStartupHealthCache();
    return jsonResponse({
      ok: true,
      codexAutoStart: codexAutoStartEnabled(config),
      startupHealth: await getCachedStartupHealth(config),
    });
  }

  if (url.pathname === "/api/diagnostics/project-config" && req.method === "GET") {
    const { getCachedProjectConfigDiagnostics } = await import("../../codex/project-config-warnings");
    const { warnings, grouped } = getCachedProjectConfigDiagnostics();
    return jsonResponse({ warnings, grouped });
  }

  if (url.pathname === "/api/sync" && req.method === "POST") {
    const { syncModelsToCodex } = await import("../../codex/sync");
    const result = await syncModelsToCodex(undefined, config, null);
    return jsonResponse({
      ...result,
      staleAppServerHint: "If Codex App still shows an older model list, restart its long-lived app-server process after sync.",
    }, result.ok ? 200 : 500);
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
    const { readUpdateJob } = await import("../../update/job");
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

  if (url.pathname === "/api/orchestration" && req.method === "GET") {
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const codexConfigPath = join(homedir(), ".codex", "config.toml");
    let tomlText = "";
    try {
      tomlText = readFileSync(codexConfigPath, "utf-8");
    } catch {}

    let planner = "root";
    let executor = "github-copilot/gpt-4.1-mini";
    let judge = "anthropic/claude-opus-5";

    const plannerMatch = tomlText.match(/\[agents\.codex-orchestration-planner\][\s\S]*?model\s*=\s*"([^"]+)"/);
    const executorMatch = tomlText.match(/\[agents\.codex-orchestration-executor\][\s\S]*?model\s*=\s*"([^"]+)"/);
    const judgeMatch = tomlText.match(/\[agents\.codex-orchestration-judge\][\s\S]*?model\s*=\s*"([^"]+)"/);

    if (plannerMatch) planner = plannerMatch[1]!;
    if (executorMatch) executor = executorMatch[1]!;
    if (judgeMatch) judge = judgeMatch[1]!;

    return jsonResponse({ planner, executor, judge });
  }

  if (url.pathname === "/api/orchestration" && req.method === "PUT") {
    let raw: any;
    try { raw = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const { planner, executor, judge } = raw;

    const os = await import("node:os");
    const fs = await import("node:fs");
    const pathLib = await import("node:path");
    const homeDir = os.homedir().replace(/\\/g, "/");
    const pluginsDir = `${homeDir}/.codex/plugins/cache/codex-orchestration/codex-orchestration`;
    let scriptPath = "";
    try {
      const versions = fs.readdirSync(pluginsDir);
      if (versions.length > 0) {
        const latestVersion = versions[0];
        scriptPath = pathLib.join(pluginsDir, latestVersion, "skills/codex-orchestration/scripts/configure_orchestration.py");
      }
    } catch {}
    if (!scriptPath) {
      scriptPath = `${homeDir}/.codex/plugins/cache/codex-orchestration/codex-orchestration/0.9.3/skills/codex-orchestration/scripts/configure_orchestration.py`;
    }

    const candidates = ["python", "py", "python3"];
    if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? pathLib.join(process.env.USERPROFILE, "AppData", "Local") : null);
      if (localAppData) {
        candidates.push(pathLib.join(localAppData, "Python", "bin", "python.exe"));
        const programsPythonDir = pathLib.join(localAppData, "Programs", "Python");
        try {
          if (fs.existsSync(programsPythonDir)) {
            const pyDirs = fs.readdirSync(programsPythonDir);
            for (const dir of pyDirs) {
              candidates.push(pathLib.join(programsPythonDir, dir, "python.exe"));
            }
          }
        } catch {}
      }
    }

    let lastError: any = new Error("No python executable found");
    let spawned = false;
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    for (const pythonCmd of candidates) {
      const args = [pythonCmd, scriptPath];
      args.push("--executor-model", executor || "github-copilot/gpt-4.1-mini");
      args.push("--executor-effort", "low");
      if (judge && judge !== "none") {
        args.push("--advisor-model", judge);
        args.push("--advisor-effort", "high");
      } else {
        args.push("--remove-advisor");
      }
      args.push("--confirm-unlisted-models");
      args.push("--apply");

      try {
        const proc = (globalThis as any).Bun.spawn(args, {
          cwd: process.cwd()
        });
        stdout = await new Response(proc.stdout).text();
        stderr = await new Response(proc.stderr).text();
        exitCode = await proc.exited;
        spawned = true;
        break;
      } catch (e: any) {
        lastError = e;
        if (e.code === "ENOENT" || e.message?.includes("ENOENT")) {
          continue;
        }
        break;
      }
    }

    if (!spawned) {
      return jsonResponse({ error: `Failed to execute python: ${lastError.message}` }, 500);
    }
    if (exitCode !== 0) {
      return jsonResponse({ error: `Script exit ${exitCode}: ${stderr || stdout}` }, 500);
    }
    return jsonResponse({ ok: true, output: stdout });
  }

  if (url.pathname === "/api/favorites" && req.method === "GET") {
    return jsonResponse({
      models: config.favorites ?? []
    });
  }

  if (url.pathname === "/api/favorites" && req.method === "PUT") {
    let raw: any;
    try { raw = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const { models } = raw;
    if (!Array.isArray(models)) {
      return jsonResponse({ error: "models must be an array of strings" }, 400);
    }
    config.favorites = models;
    saveConfig(config);
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ ok: true, models: config.favorites });
  }

  return null;
}
