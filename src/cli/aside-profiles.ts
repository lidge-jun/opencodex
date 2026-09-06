import type { OwnedIntegrationRefreshOutcome } from "../integrations/owned-refresh";
import { runtimeRequest, RuntimeApiError, type RuntimeApiDeps } from "./runtime-api";

/** Aside policy and file writes share the running server's mutation owner. Never fall back locally. */
export async function refreshAsideProfilesThroughServer(
  deps: RuntimeApiDeps = {},
): Promise<OwnedIntegrationRefreshOutcome[]> {
  const result = await runtimeRequest<{ results?: OwnedIntegrationRefreshOutcome[] }>(
    "/api/client-integrations/aside/sync",
    { method: "POST", body: "{}" },
    deps,
  );
  if (!Array.isArray(result.results)) {
    throw new RuntimeApiError("The running proxy does not support Aside profile synchronization", 502, result);
  }
  return result.results;
}
