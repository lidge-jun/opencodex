import { resolveZedModels } from "../../providers/zed";
import type { OcxProviderConfig } from "../../types";
import { jsonResponse } from "../auth-cors";

/**
 * Connection test for the experimental Zed Hosted AI provider.
 *
 * Lives outside `provider-routes.ts`, which sits at the file-size threshold, and is reached by a
 * dynamic import so Zed code stays off the module graph until someone tests a Zed row. The probe
 * forces a live roster fetch, which exercises the account lookup, the short-lived LLM token
 * exchange and the model list in one call. Failures return a fixed message: an upstream error can
 * echo account material, and the caller only needs to know that discovery failed.
 */
export async function probeZedProvider(
  prov: OcxProviderConfig,
  apiKey: string | undefined,
  zedUserId: string | undefined,
): Promise<Response> {
  const started = Date.now();
  if (!zedUserId) {
    return jsonResponse({ ok: false, latencyMs: 0, error: "Zed account identity is unavailable — re-run `ocx login zed`" });
  }
  try {
    const zedFetch = (prov as OcxProviderConfig & { fetch?: typeof globalThis.fetch }).fetch;
    const live = await resolveZedModels(
      { userId: zedUserId, accessToken: apiKey ?? "" },
      { forceRefresh: true, signal: AbortSignal.timeout(8_000), ...(zedFetch ? { fetchFn: zedFetch } : {}) },
    );
    return jsonResponse({
      ok: true,
      latencyMs: Date.now() - started,
      models: live.models.length,
      message: `Connected. ${live.models.length} models.`,
    });
  } catch {
    return jsonResponse({ ok: false, latencyMs: Date.now() - started, error: "zed model discovery failed" });
  }
}
