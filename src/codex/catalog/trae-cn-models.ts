import { openTraeSession } from "../../adapters/trae-cn/client";
import { traeCnDestinationMatches } from "../../adapters/trae-cn/profile";
import {
  captureModelCacheGeneration,
  DEFAULT_MODEL_CACHE_TTL_MS,
  getFreshCached,
  getPinnedCached,
  getStaleCached,
  isModelCacheGenerationCurrent,
  isModelsFetchCoolingDown,
  markModelsFetchFailure,
  markProviderDiscoveryFailed,
  markProviderDiscoveryOk,
  observeModelCacheRevision,
  pinCachedModels,
  setCached,
} from "../model-cache";
import { applyProviderConfigHints } from "./model-hints";
import type { CapturedProviderGather } from "./gather-capture";
import type { ProviderModelsResult } from "./provider-models";
import type { CatalogModel } from "./parsing";
import type { OcxConfig } from "../../types";
import { providerContextCap } from "../../providers/context-cap";

/** Prepare CLI-owned evidence in the background source phase, independently of management admission. */
export async function refreshTraeCnCatalogSources(
  config: Readonly<OcxConfig>, current: () => boolean = () => true,
  after?: () => Promise<unknown>,
): Promise<void> {
  const { fetchProviderModelsWithAuth, refreshingModelsAuthResolver } = await import("./provider-models");
  const { captureProviderGather } = await import("./gather-capture");
  const retained: Array<{ name: string; contentRevision: string; release: () => void }> = [];
  const releaseRetained = (): void => {
    for (const roster of retained.reverse()) roster.release();
    retained.length = 0;
  };
  for (const [name, provider] of Object.entries(config.providers)) {
    if (!current()) { releaseRetained(); return; }
    if (provider.adapter !== "trae-cn" || provider.disabled || provider.liveModels === false) continue;
    const gathered = await fetchProviderModelsWithAuth(captureProviderGather(name, provider, refreshingModelsAuthResolver),
      config.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS, providerContextCap(config, name), refreshingModelsAuthResolver);
    if (!current()) { releaseRetained(); return; }
    if (after && gathered.outcome.state === "authoritative") {
      const release = pinCachedModels(name, gathered.models, Date.now(), captureModelCacheGeneration(name));
      if (!release) { releaseRetained(); return; }
      retained.push({ name, release, contentRevision: observeModelCacheRevision(name) });
    }
  }
  if (!after || retained.length === 0) return;
  if (!current() || retained.some(roster => observeModelCacheRevision(roster.name) !== roster.contentRevision)) {
    releaseRetained();
    return;
  }
  try {
    await after();
  } finally {
    releaseRetained();
  }
}

/** Discover an account roster with bounded failure retries and current hints on every cached return. */
export async function fetchTraeCnProviderModels(
  captured: CapturedProviderGather,
  ttlMs: number,
  contextCap: number | undefined,
  configured: CatalogModel[],
  withConfiguredRetention: (models: CatalogModel[]) => CatalogModel[],
  allowDiscovery: boolean,
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
  const fresh = getPinnedCached(name) ?? getFreshCached(name, ttlMs, Date.now());
  if (fresh) return observed(fresh, "authoritative");
  const stale = getStaleCached(name);
  // Observed gathers cannot bind the CLI's live sign-in to their captured auth snapshot.
  if (!allowDiscovery) return observed(stale ?? configured, "degraded");
  if (isModelsFetchCoolingDown(name)) return observed(stale ?? configured, "degraded");
  const generation = captureModelCacheGeneration(name);
  const currentFallback = (): ProviderModelsResult => observed(getStaleCached(name) ?? configured, "degraded");
  try {
    const session = await openTraeSession(provider.baseUrl, { timeoutMs: 15_000 }, undefined, provider);
    await session.close();
    if (!isModelCacheGenerationCurrent(name, generation)) return currentFallback();
    const models = session.models.map(id => applyProviderConfigHints(name, provider,
      { id, provider: name, inputModalities: ["text"] }, contextCap, metadataModelIdCaseFold,
      captured.effectiveAlias, metadataConfigDir, false));
    if (!setCached(name, models, Date.now(), generation)) return currentFallback();
    markProviderDiscoveryOk(name, models.length);
    return observed(models, "authoritative");
  } catch {
    if (isModelCacheGenerationCurrent(name, generation)) {
      markModelsFetchFailure(name);
      markProviderDiscoveryFailed(name, { reason: "provider" });
    }
    return currentFallback();
  }
}
