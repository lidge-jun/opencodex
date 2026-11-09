import { discoverQoderModels, QODER_INTERACTIVE_DEADLINE_MS } from "../../adapters/qoder/live-models";
import { resolveQoderProfile } from "../../adapters/qoder/profiles";
import { captureModelCacheGeneration, isModelCacheGenerationCurrent } from "../../codex/model-cache";
import { clearGatherRoutedModelsInflight } from "../../codex/catalog/routed-gather";
import type { OcxProviderConfig } from "../../types";
import { jsonResponse } from "../auth-cors";

export interface QoderProbeDeps {
  deadlineMs?: number;
  /** Waits between re-sync attempts; the first attempt runs at once. */
  resyncDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  clearGatherInflight?: () => void;
}

/** Re-sync attempts after a late success: at once, then while a busy or stale convergence clears. */
export const QODER_LATE_RESYNC_DELAYS_MS = [0, 2_000, 5_000, 10_000] as const;

function retryable(disposition: unknown): boolean {
  const outcome = disposition as { status?: unknown; retryable?: unknown } | null | undefined;
  return (outcome?.status === "skipped" || outcome?.status === "failed") && outcome.retryable === true;
}

/**
 * Publish a late roster. The finished run is not stored yet, so the convergence gather prefers it
 * over the cached roster, which stays as the fallback if publication never happens. Each attempt
 * first drops in-flight aggregate gathers, as a provider reload does: one that started before the
 * run finished may already hold the old roster and would hand it to the convergence that joins it.
 * A busy or stale convergence is retried; an invalidated cache generation ends the attempts.
 */
async function resyncAfterLateSuccess(
  name: string,
  generation: string,
  converge: () => Promise<unknown>,
  deps: QoderProbeDeps,
): Promise<void> {
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); }));
  for (const delay of deps.resyncDelaysMs ?? QODER_LATE_RESYNC_DELAYS_MS) {
    if (delay > 0) await sleep(delay);
    if (!isModelCacheGenerationCurrent(name, generation)) return;
    (deps.clearGatherInflight ?? clearGatherRoutedModelsInflight)();
    let disposition: unknown;
    try { disposition = await converge(); } catch { continue; }
    if (!retryable(disposition)) return;
  }
}

/**
 * Connection test for Qoder (#8115). Lives outside `provider-routes.ts`, which sits at the
 * file-size threshold.
 *
 * `qoder --list-models` can take longer than this interactive test should wait, so the test joins
 * the shared background discovery (the same run the catalog gather uses, with its longer bound)
 * and waits only its own short deadline. Past it, the provider is reported as still discovering
 * rather than failed. A later success runs `converge`, the management catalog convergence, whose
 * gather reads that run ahead of the cached roster and publishes the models without a proxy
 * restart; running Codex sessions keep their copy until restarted (see
 * {@link resyncAfterLateSuccess}). Nothing happens when the cache was invalidated meanwhile: the run
 * belongs to the previous generation.
 */
export async function probeQoderProvider(
  name: string,
  prov: OcxProviderConfig,
  apiKey: string | undefined,
  converge: () => Promise<unknown>,
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
      if (result.ok) return resyncAfterLateSuccess(name, generation, converge, deps);
    }).catch(() => undefined);
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
