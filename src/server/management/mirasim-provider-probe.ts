import type { OcxProviderConfig } from "../../types";
import { jsonResponse } from "../auth-cors";

export async function probeMirasimProviderLiveCatalog(
  providerName: string,
  provider: OcxProviderConfig,
  apiKey: string,
): Promise<Response> {
  const started = Date.now();
  const { fetchMirasimLiveCatalog } = await import("../../adapters/mirasim/control-plane");
  const live = await fetchMirasimLiveCatalog(providerName, provider, apiKey);
  const latencyMs = Date.now() - started;
  if (!live.ok) {
    return jsonResponse({
      ok: false,
      latencyMs,
      error: live.status
        ? `mirasim discovery returned HTTP ${live.status}`
        : `mirasim discovery ${live.reason}`,
    });
  }
  return jsonResponse({
    ok: true,
    latencyMs,
    models: live.models.length,
    message: `Connected. ${live.models.length} models.`,
  });
}
