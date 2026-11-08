import { openTraeSession } from "../../adapters/trae-cn/client";
import { traeCnDestinationMatches } from "../../adapters/trae-cn/profile";
import {
  captureModelCacheGeneration,
  getFreshCached,
  getStaleCached,
  isModelCacheGenerationCurrent,
  isModelsFetchCoolingDown,
  markModelsFetchFailure,
  markProviderDiscoveryFailed,
  markProviderDiscoveryOk,
  observeModelCacheRevision,
  setCached,
} from "../model-cache";
import { applyProviderConfigHints } from "./model-hints";
import type { CapturedProviderGather } from "./gather-capture";
import type { ProviderModelsResult } from "./provider-models";
import type { CatalogModel } from "./parsing";

/** Discover an account roster with bounded failure retries and current hints on every cached return. */
export async function fetchTraeCnProviderModels(
  captured: CapturedProviderGather,
  ttlMs: number,
  contextCap: number | undefined,
  configured: CatalogModel[],
  withConfiguredRetention: (models: CatalogModel[]) => CatalogModel[],
): Promise<ProviderModelsResult> {
  const { name, provider, metadataModelIdCaseFold, metadataConfigDir } = captured;
  const observed = (models: CatalogModel[], state: ProviderModelsResult["outcome"]["state"]): ProviderModelsResult => ({
    models: withConfiguredRetention(models.map(model => applyProviderConfigHints(name, provider, model,
      contextCap, metadataModelIdCaseFold, captured.effectiveAlias, metadataConfigDir, false)))
      .map(model => ({ ...model, inputModalities: ["text"], supportsVerbosity: false })),
    outcome: { provider: name, state }, contentRevision: observeModelCacheRevision(name),
  });
  if (!traeCnDestinationMatches(provider.baseUrl) || provider.proxy !== undefined || provider.noProxy !== undefined) {
    markProviderDiscoveryFailed(name, { reason: "blocked" });
    return observed(configured, "degraded");
  }
  const fresh = getFreshCached(name, ttlMs, Date.now());
  if (fresh) return observed(fresh, "authoritative");
  const stale = getStaleCached(name);
  if (isModelsFetchCoolingDown(name)) return observed(stale ?? configured, "degraded");
  const generation = captureModelCacheGeneration(name);
  try {
    const session = await openTraeSession(provider.baseUrl, { timeoutMs: 15_000 }, undefined, provider);
    await session.close();
    if (!isModelCacheGenerationCurrent(name, generation)) return observed(stale ?? configured, "degraded");
    const models = session.models.map(id => applyProviderConfigHints(name, provider,
      { id, provider: name, inputModalities: ["text"] }, contextCap, metadataModelIdCaseFold,
      captured.effectiveAlias, metadataConfigDir, false));
    if (!setCached(name, models, Date.now(), generation)) return observed(stale ?? configured, "degraded");
    markProviderDiscoveryOk(name, models.length);
    return observed(models, "authoritative");
  } catch {
    if (isModelCacheGenerationCurrent(name, generation)) {
      markModelsFetchFailure(name);
      markProviderDiscoveryFailed(name, { reason: "provider" });
    }
    return observed(stale ?? configured, "degraded");
  }
}
