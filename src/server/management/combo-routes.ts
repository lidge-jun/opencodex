import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CatalogModel } from "../../codex/catalog";
import { catalogModelSlug, filterCatalogVisibleModels, invalidateCodexModelsCache, nativeModelRows, uniqueCatalogModelsForPublicList } from "../../codex/catalog";
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

export async function handleComboRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps, refreshCodexCatalogBestEffort, syncClaudeAgentDefsBestEffort } = ctx;

  if (url.pathname === "/api/combos" && req.method === "GET") {
    const { comboPublicModelId, getCombo, listComboIds } = await import("../../combos");
    return jsonResponse({ combos: listComboIds(config).map(id => {
      const combo = getCombo(config, id)!;
      return {
        id,
        model: comboPublicModelId(id, combo),
        ...combo,
      };
    }) });
  }

  if (url.pathname === "/api/smart-routing" && req.method === "POST") {
    const { buildSmartRoutingCombo, clearComboSelectionState, clearComboTargetCooldowns, SMART_ROUTING_MODES } = await import("../../combos");
    let body: unknown;
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const mode = isPlainRecord(body) && typeof body.mode === "string"
      ? SMART_ROUTING_MODES.find(candidate => candidate === body.mode)
      : undefined;
    if (!mode) {
      return jsonResponse({ error: `mode must be one of: ${SMART_ROUTING_MODES.join(", ")}` }, 400);
    }
    const models = filterCatalogVisibleModels(await fetchAllModels(config), config);
    const combo = buildSmartRoutingCombo(mode, models, config);
    if (!combo) {
      const error = mode === "cost"
        ? "no enabled models with verified pricing can be routed in cost mode"
        : `no enabled models can be routed in ${mode} mode`;
      return jsonResponse({ error }, 400);
    }
    const id = `auto-${mode}`;
    config.combos = { ...(config.combos ?? {}), [id]: combo };
    saveConfig(config);
    clearComboSelectionState(id);
    clearComboTargetCooldowns(id);
    await refreshCodexCatalogBestEffort();
    return jsonResponse({
      success: true,
      mode,
      id,
      model: `combo/${id}`,
      targets: combo.targets,
    });
  }

  if (url.pathname === "/api/combos" && req.method === "PUT") {
    let rawBody: unknown;
    try { rawBody = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(rawBody)) {
      return jsonResponse({ error: "request body must be an object" }, 400);
    }
    const body = rawBody;
    if (typeof body.id !== "string" || !body.id.trim()) {
      return jsonResponse({ error: "id is required and must be a string" }, 400);
    }
    const id = body.id.trim();
    let renameFrom: string | undefined;
    if (body.renameFrom !== undefined) {
      if (typeof body.renameFrom !== "string" || !body.renameFrom.trim()) {
        return jsonResponse({ error: "renameFrom must be a non-empty string" }, 400);
      }
      renameFrom = body.renameFrom.trim();
      if (renameFrom === id) {
        return jsonResponse({ error: "renameFrom must differ from id" }, 400);
      }
      if (!Object.hasOwn(config.combos ?? {}, renameFrom)) {
        return jsonResponse({ error: `combo "${renameFrom}" does not exist` }, 400);
      }
      if (Object.hasOwn(config.combos ?? {}, id)) {
        return jsonResponse({ error: `combo "${id}" already exists` }, 400);
      }
    }
    const {
      clearComboSelectionState,
      clearComboTargetCooldowns,
      comboConfigError,
      comboModelId,
      comboPublicModelId,
      normalizeComboConfig,
    } = await import("../../combos");
    const error = comboConfigError(id, body.combo, config.providers, {
      requireEnabledTarget: true,
      combos: config.combos,
      excludeComboId: renameFrom ?? id,
    });
    if (error) return jsonResponse({ error }, 400);
    const normalized = normalizeComboConfig(body.combo as import("../../types").OcxComboConfig);
    const stored: import("../../types").OcxComboConfig = normalized.alias === null
      ? (({ alias: _alias, ...rest }) => rest)(normalized)
      : normalized;
    const sourceId = renameFrom ?? id;
    const previous = config.combos?.[sourceId];
    const oldPublicModel = previous ? comboPublicModelId(sourceId, previous) : null;
    const newPublicModel = comboPublicModelId(id, normalized);
    const nextCombos = { ...(config.combos ?? {}) };
    if (renameFrom) delete nextCombos[renameFrom];
    nextCombos[id] = stored;
    config.combos = nextCombos;
    let shouldSyncClaudeAgentDefs = false;
    const migratedModels = new Set<string>();
    if (oldPublicModel && oldPublicModel !== newPublicModel) {
      migratedModels.add(oldPublicModel);
    }
    if (renameFrom) migratedModels.add(comboModelId(renameFrom));
    if (migratedModels.size > 0) {
      const migrateReference = (model: string): string => (
        migratedModels.has(model) ? newPublicModel : model
      );
      const migrateAgentReference = (model: string): string => {
        const migrated = migrateReference(model);
        if (migrated !== model) shouldSyncClaudeAgentDefs = true;
        return migrated;
      };
      const migrateReferences = (models: string[]): string[] => [
        ...new Set(models.map(migrateReference)),
      ];
      if (config.disabledModels) {
        config.disabledModels = migrateReferences(config.disabledModels);
      }
      if (config.subagentModels) {
        config.subagentModels = [...new Set(config.subagentModels.map(migrateAgentReference))];
      }
      if (config.injectionModel && migratedModels.has(config.injectionModel)) {
        config.injectionModel = newPublicModel;
      }
      if (config.shadowCallIntercept?.model && migratedModels.has(config.shadowCallIntercept.model)) {
        config.shadowCallIntercept = {
          ...config.shadowCallIntercept,
          model: newPublicModel,
        };
      }
      if (config.claudeCode) {
        const claudeCode = { ...config.claudeCode };
        for (const field of ["model", "smallFastModel"] as const) {
          if (claudeCode[field]) claudeCode[field] = migrateAgentReference(claudeCode[field]);
        }
        if (claudeCode.tierModels) {
          claudeCode.tierModels = Object.fromEntries(
            Object.entries(claudeCode.tierModels).map(([tier, model]) => [tier, migrateAgentReference(model)]),
          );
        }
        if (claudeCode.modelMap) {
          claudeCode.modelMap = Object.fromEntries(
            Object.entries(claudeCode.modelMap).map(([source, model]) => [source, migrateAgentReference(model)]),
          );
        }
        config.claudeCode = claudeCode;
      }
    }
    saveConfig(config);
    clearComboSelectionState(id);
    clearComboTargetCooldowns(id);
    if (renameFrom) {
      clearComboSelectionState(renameFrom);
      clearComboTargetCooldowns(renameFrom);
    }
    await refreshCodexCatalogBestEffort();
    if (shouldSyncClaudeAgentDefs) await syncClaudeAgentDefsBestEffort();
    return jsonResponse({ success: true, id, model: newPublicModel, combo: normalized });
  }

  if (url.pathname === "/api/combos" && req.method === "DELETE") {
    const id = url.searchParams.get("id")?.trim();
    if (!id) return jsonResponse({ error: "id query param is required" }, 400);
    if (!Object.hasOwn(config.combos ?? {}, id)) {
      return jsonResponse({ error: "unknown combo" }, 404);
    }
    const { clearComboSelectionState, clearComboTargetCooldowns } = await import("../../combos");
    delete config.combos![id];
    if (Object.keys(config.combos!).length === 0) delete config.combos;
    saveConfig(config);
    clearComboSelectionState(id);
    clearComboTargetCooldowns(id);
    await refreshCodexCatalogBestEffort();
    return jsonResponse({ success: true, id });
  }
  return null;
}
