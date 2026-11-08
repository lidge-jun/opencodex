import { openTraeSession, type TraeAcpDeps } from "../../adapters/trae-cn/client";
import { captureModelCacheGeneration, clearModelCache, isModelCacheGenerationCurrent, markProviderDiscoveryOk, setCached } from "../../codex/model-cache";
import type { CatalogDisposition } from "../../codex/convergence-types";
import type { OwnedIntegrationRefreshOutcome } from "../../integrations/owned-refresh";
import { clearGatherRoutedModelsInflight } from "../../codex/catalog/routed-gather";
import { redactSecretString } from "../../lib/redact";
import type { OcxProviderConfig } from "../../types";
import { jsonResponse } from "../auth-cors";

interface TraeCnProbeDeps extends TraeAcpDeps {
  refreshConnectedClients?: (admit: () => boolean) => Promise<OwnedIntegrationRefreshOutcome[]>;
}

/** Probe the signed-in CLI directly; cached or seeded model rows are not connection evidence. */
export async function probeTraeCnProvider(
  name: string, provider: OcxProviderConfig, converge: () => Promise<CatalogDisposition>,
  signal?: AbortSignal, deps: TraeCnProbeDeps = {},
): Promise<Response> {
  const started = Date.now();
  const generation = captureModelCacheGeneration(name);
  try {
    const session = await openTraeSession(provider.baseUrl, { timeoutMs: 15_000, ...deps }, signal, provider);
    await session.close();
    let catalogRefresh: CatalogDisposition = { status: "skipped", reason: "stale", retryable: true };
    let rosterReplaced = false;
    let clientIntegrations: OwnedIntegrationRefreshOutcome[] = [];
    let clientRefreshPending = false;
    if (isModelCacheGenerationCurrent(name, generation)) {
      clearModelCache(name);
      setCached(name, session.models.map(id => ({ id, provider: name, inputModalities: ["text"], supportsVerbosity: false })),
        Date.now(), captureModelCacheGeneration(name));
      rosterReplaced = true;
      markProviderDiscoveryOk(name, session.models.length);
      clearGatherRoutedModelsInflight();
      const publishedGeneration = captureModelCacheGeneration(name);
      try { catalogRefresh = await converge(); } catch {
        catalogRefresh = { status: "failed", reason: "internal", phase: "commit", retryable: true, partialWrite: false };
      }
      const admit = () => isModelCacheGenerationCurrent(name, publishedGeneration);
      if (deps.refreshConnectedClients) {
        if (!admit()) clientRefreshPending = true;
        else try {
          clientIntegrations = await deps.refreshConnectedClients(admit);
          clientRefreshPending = !admit() || clientIntegrations.some(result => !result.ok);
        } catch { clientRefreshPending = true; }
      }
    }
    const published = catalogRefresh.status === "committed" && !catalogRefresh.degraded;
    const staleProbe = !rosterReplaced;
    return jsonResponse({ ok: true, models: session.models.length, latencyMs: Date.now() - started, rosterReplaced, catalogRefresh, clientIntegrations, clientRefreshPending,
      message: `Connected. ${session.models.length} models. ${staleProbe
        ? "The provider changed during the probe; this roster was not published. Run Test connection again."
        : published && !clientRefreshPending
        ? "Catalog refreshed; restart running Codex sessions to load it."
        : "Catalog refresh is pending; sync the catalog before restarting running Codex sessions."}` });
  } catch (error) {
    return jsonResponse({ ok: false, latencyMs: Date.now() - started,
      error: redactSecretString(error instanceof Error ? error.message : "TRAE CN ACP connection failed").slice(0, 512) });
  }
}
