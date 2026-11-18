import { useClientResource, useKeyedClientResource } from "../client-resource";
import { STARTUP_HEALTH_STALE_RETRY_MS, type StartupChecklistBody } from "../startup-health-ui";

type StartupBody = StartupChecklistBody;

export function useStartupChecklist(apiBase: string) {
  const key = `home-startup:${apiBase}`;
  const load = async (signal: AbortSignal): Promise<StartupBody | null> => {
    const response = await fetch(`${apiBase}/api/startup-health`, { signal });
    return response.ok ? (await response.json()) as StartupBody : null;
  };
  const resource = useKeyedClientResource(key, [apiBase], load);
  // A second subscription delegates scheduling and in-flight deduplication to the
  // shared resource. Remove it after a fresh result or any failed attempt.
  useClientResource(key, load, {
    enabled: resource.lastAttemptOk && resource.data?.diagnosticStale === true,
    pollMs: STARTUP_HEALTH_STALE_RETRY_MS,
  });
  return resource;
}
