import type { OwnedIntegrationRefreshOutcome } from "../integrations/owned-refresh";
import { createIntegrationStateStore, type IntegrationStateStore } from "../integrations/store";
import { runtimeRequest, type RuntimeApiDeps } from "./runtime-api";

/** Kept in step with `PI_SYNC_PATH` in src/server/management/integration-routes.ts. */
export const PI_SYNC_ROUTE = "/api/client-integrations/pi/sync";

/**
 * Refresh an already-connected Pi file through the running proxy.
 *
 * Pi may carry raw nested selectors, and only the proxy that serves them can prove each one
 * routes to the same model (#8172). The CLI's saved configuration and its in-process router
 * cache are not that proof, so there is deliberately no local fallback: a refusal or an older
 * proxy without the route is reported as a Pi outcome and the file is left as it is.
 */
export async function refreshPiThroughServer(
  deps: RuntimeApiDeps & { store?: IntegrationStateStore; request?: typeof runtimeRequest } = {},
): Promise<OwnedIntegrationRefreshOutcome[]> {
  // The ownership record is the user's opt-in; an unconnected Pi never reaches the server.
  const record = (deps.store ?? createIntegrationStateStore()).readRecords().pi;
  if (!record || record.clientId !== "pi") return [];
  try {
    const result = await (deps.request ?? runtimeRequest)<{ results?: OwnedIntegrationRefreshOutcome[] }>(
      PI_SYNC_ROUTE,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      deps,
    );
    if (!Array.isArray(result.results)) {
      return [{ client: "pi", ok: false, reason: "The running proxy does not support Pi synchronization; restart it to refresh Pi." }];
    }
    return result.results.filter(outcome => outcome.client === "pi");
  } catch (error) {
    return [{ client: "pi", ok: false, reason: error instanceof Error ? error.message : String(error) }];
  }
}
