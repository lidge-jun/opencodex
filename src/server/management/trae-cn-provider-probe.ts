import { openTraeSession, type TraeAcpDeps } from "../../adapters/trae-cn/client";
import { captureModelCacheGeneration, clearModelCache, isModelCacheGenerationCurrent } from "../../codex/model-cache";
import { clearGatherRoutedModelsInflight } from "../../codex/catalog/routed-gather";
import { redactSecretString } from "../../lib/redact";
import type { OcxProviderConfig } from "../../types";
import { jsonResponse } from "../auth-cors";

/** Probe the signed-in CLI directly; cached or seeded model rows are not connection evidence. */
export async function probeTraeCnProvider(
  name: string, provider: OcxProviderConfig, signal?: AbortSignal, deps: TraeAcpDeps = {},
): Promise<Response> {
  const started = Date.now();
  const generation = captureModelCacheGeneration(name);
  try {
    const session = await openTraeSession(provider.baseUrl, { timeoutMs: 15_000, ...deps }, signal);
    try {
      if (isModelCacheGenerationCurrent(name, generation)) {
        clearModelCache(name);
        clearGatherRoutedModelsInflight();
      }
      return jsonResponse({ ok: true, models: session.models.length, latencyMs: Date.now() - started,
        message: `Connected. ${session.models.length} models.` });
    } finally { await session.close(); }
  } catch (error) {
    return jsonResponse({ ok: false, latencyMs: Date.now() - started,
      error: redactSecretString(error instanceof Error ? error.message : "TRAE CN ACP connection failed").slice(0, 512) });
  }
}
