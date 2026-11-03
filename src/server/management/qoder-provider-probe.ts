import { discoverQoderModels, QODER_INTERACTIVE_DEADLINE_MS } from "../../adapters/qoder/live-models";
import { resolveQoderProfile } from "../../adapters/qoder/profiles";
import { captureModelCacheGeneration, clearModelCache, isModelCacheGenerationCurrent } from "../../codex/model-cache";
import type { OcxProviderConfig } from "../../types";
import { jsonResponse } from "../auth-cors";

export interface QoderProbeDeps {
  deadlineMs?: number;
}

/**
 * Connection test for Qoder (#8115). Lives outside `provider-routes.ts`, which sits at the
 * file-size threshold.
 *
 * `qoder --list-models` can take longer than this interactive test should wait, so the test joins
 * the shared background discovery (the same run the catalog gather uses, with its longer bound)
 * and waits only its own short deadline. Past it, the provider is reported as still discovering
 * rather than failed. A later success evicts the provider's cached roster (keeping its generation,
 * so the finished run stays joinable) and runs `onLateSuccess`, the management catalog
 * convergence, whose gather reads that run and publishes the models without a restart. Nothing
 * happens when the cache was invalidated meanwhile: the run belongs to the previous generation.
 */
export async function probeQoderProvider(
  name: string,
  prov: OcxProviderConfig,
  apiKey: string | undefined,
  onLateSuccess: () => void,
  deps: QoderProbeDeps = {},
): Promise<Response> {
  const started = Date.now();
  const profile = resolveQoderProfile(prov.baseUrl);
  if (!profile) {
    return jsonResponse({ ok: false, latencyMs: 0, error: "qoder discovery refused a non-canonical destination" });
  }
  const generation = captureModelCacheGeneration(name);
  const run = discoverQoderModels(profile, apiKey ?? "", `${name}\0${generation}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), deps.deadlineMs ?? QODER_INTERACTIVE_DEADLINE_MS);
  });
  const live = await Promise.race([run, deadline]).finally(() => clearTimeout(timer));
  const latencyMs = Date.now() - started;
  if (live === null) {
    void run.then(result => {
      if (!result.ok || !isModelCacheGenerationCurrent(name, generation)) return;
      clearModelCache(name, "eviction");
      onLateSuccess();
    }, () => undefined);
    return jsonResponse({
      ok: true,
      discovering: true,
      latencyMs,
      message: "Qoder is still listing models; they appear in the catalog when discovery finishes.",
    });
  }
  if (!live.ok) {
    return jsonResponse({
      ok: false,
      latencyMs,
      error: `qoder discovery ${live.error}${live.detail ? `: ${live.detail}` : ""}`,
    });
  }
  return jsonResponse({
    ok: true,
    latencyMs,
    models: live.models.length,
    message: `Connected. ${live.models.length} models.`,
  });
}
