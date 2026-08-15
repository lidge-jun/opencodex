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
import { enrichProviderFromCatalog, listKeyLoginProviders } from "../../oauth/key-providers";
import { deriveProviderPresets } from "../../providers/derive";
import { providerCodexAccountMode } from "../../providers/registry";
import { routedSlug, slugEquals } from "../../providers/slug-codec";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../../providers/quota";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import {
  CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR,
  codexAccountNamespaceForModel,
} from "../../codex/account-namespace-match";
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
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import { filterRequestLogs, getRequestLogEntries, type RequestLogEntry } from "../request-log";
import { estimateComboCost, estimateRequestCost, normalizeCostTokens, tokensPerSecond } from "../../usage/cost";
import type { PersistedUsageAttempt } from "../../usage/log";
import { isAllowedRequestOrigin, jsonResponse, providerManagementConfigError, publicProviderBaseUrl, safeConfigDTO } from "../auth-cors";
import { applySystemEnvToggle } from "../system-env";

import { isPlainRecord, parseDebugLogQuery, tokPerSecondResult, unavailableCostReason, costResult, requestLogDto, stripRegistryOnlyStaticHeaders, fetchAllModels } from "./shared";
import type { MetricUnavailableReason, TokPerSecondResult, CostEstimateReason, CostResult, MetricSource } from "./shared";
import type { ManagementContext } from "./context";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";


/** Management wire shape: omit default imageInput "auto" (persist/response sparse). */
function sparseComboConfig<T extends { imageInput?: "auto" | "disabled" }>(combo: T): Omit<T, "imageInput"> & { imageInput?: "disabled" } {
  const { imageInput, ...rest } = combo;
  return {
    ...rest,
    ...(imageInput === "disabled" ? { imageInput: "disabled" as const } : {}),
  };
}

export async function handleComboRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps, convergeCodexCatalog, syncClaudeAgentDefsBestEffort } = ctx;

  if (url.pathname === "/api/combos" && req.method === "GET") {
    const { comboPublicModelId, getCombo, listComboIds } = await import("../../combos");
    return jsonResponse({ combos: listComboIds(config).map(id => {
      const combo = getCombo(config, id)!;
      return {
        id,
        model: comboPublicModelId(id, combo),
        ...sparseComboConfig(combo),
      };
    }) });
  }

  if (url.pathname === "/api/combos" && req.method === "PUT") {
    let rawBody: unknown;
    try { rawBody = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
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
      comboDisabledModelId,
      comboDisabledModelSelectors,
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
    // Persist only non-default identity/capability fields so config stays sparse.
    const {
      alias: normalizedAlias,
      nativeAlias: normalizedNativeAlias,
      displayName: normalizedDisplayName,
      imageInput: normalizedImageInput,
      ...normalizedBase
    } = normalized;
    const stored: import("../../types").OcxComboConfig = {
      ...normalizedBase,
      ...(normalizedAlias ? { alias: normalizedAlias } : {}),
      ...(normalizedNativeAlias ? { nativeAlias: true } : {}),
      ...(normalizedDisplayName ? { displayName: normalizedDisplayName } : {}),
      ...(normalizedImageInput === "disabled" ? { imageInput: "disabled" as const } : {}),
    };
    const sourceId = renameFrom ?? id;
    const previous = config.combos?.[sourceId];
    const oldPublicModel = previous ? comboPublicModelId(sourceId, previous) : null;
    const newPublicModel = comboPublicModelId(id, normalized);
    const disabledIdentityChanged = previous !== undefined && (
      renameFrom !== undefined
      || oldPublicModel !== newPublicModel
      || (previous.nativeAlias === true) !== normalized.nativeAlias
    );
    const oldDisabledSelectors = disabledIdentityChanged
      ? new Set(comboDisabledModelSelectors(sourceId, previous))
      : new Set<string>();
    const newDisabledModel = comboDisabledModelId(id, normalized);
    if (codexAccountNamespaceForModel(config.codexAccountNamespaces, newPublicModel)) {
      return jsonResponse({ error: CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR }, 409);
    }
    const nextCombos = { ...(config.combos ?? {}) };
    if (renameFrom) delete nextCombos[renameFrom];
    nextCombos[id] = stored;
    config.combos = nextCombos;
    let shouldSyncClaudeAgentDefs = false;
    const migratedModels = new Map<string, string>();
    if (oldPublicModel && oldPublicModel !== newPublicModel && previous?.nativeAlias !== true) {
      migratedModels.set(oldPublicModel, newPublicModel);
    }
    if (renameFrom) {
      // A bare native id is ambiguous after the alias changes. Preserve it as a native route,
      // while the unambiguous canonical combo reference follows the renamed combo.
      migratedModels.set(
        comboModelId(renameFrom),
        previous?.nativeAlias === true ? comboModelId(id) : newPublicModel,
      );
    }
    if (migratedModels.size > 0) {
      const migrateReference = (model: string): string => migratedModels.get(model) ?? model;
      const migrateAgentReference = (model: string): string => {
        const migrated = migrateReference(model);
        if (migrated !== model) shouldSyncClaudeAgentDefs = true;
        return migrated;
      };
      if (config.subagentModels) {
        config.subagentModels = [...new Set(config.subagentModels.map(migrateAgentReference))];
      }
      if (config.injectionModel && migratedModels.has(config.injectionModel)) {
        config.injectionModel = migrateReference(config.injectionModel);
      }
      if (config.shadowCallIntercept?.model && migratedModels.has(config.shadowCallIntercept.model)) {
        config.shadowCallIntercept = {
          ...config.shadowCallIntercept,
          model: migrateReference(config.shadowCallIntercept.model),
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
    if (oldDisabledSelectors.size > 0 && config.disabledModels) {
      config.disabledModels = [...new Set(config.disabledModels.map(model => (
        oldDisabledSelectors.has(model) ? newDisabledModel : model
      )))];
    }
    saveConfigPreservingClaudeCode(config);
    reconcileLiveStateStores();
    clearComboSelectionState(id);
    clearComboTargetCooldowns(id);
    if (renameFrom) {
      clearComboSelectionState(renameFrom);
      clearComboTargetCooldowns(renameFrom);
    }
    const catalogRefresh = await convergeCodexCatalog();
    if (shouldSyncClaudeAgentDefs) await syncClaudeAgentDefsBestEffort();
    // Wire shape matches persistence: omit default imageInput "auto".
    return jsonResponse({ success: true, id, model: newPublicModel, combo: sparseComboConfig(stored), catalogRefresh });
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
    saveConfigPreservingClaudeCode(config);
    reconcileLiveStateStores();
    clearComboSelectionState(id);
    clearComboTargetCooldowns(id);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ success: true, id, catalogRefresh });
  }
  return null;
}
