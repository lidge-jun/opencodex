import { mutatePersistedConfig } from "../config";
import { migrateXaiResponsesDefault } from "../providers/xai-responses-opt-in";
import type { OcxConfig } from "../types";

/** Rebase the one-time wire upgrade before initializing any live config consumers. */
export function migrateStartupXaiResponses(config: OcxConfig): OcxConfig {
  const projection = { ...config };
  if (!migrateXaiResponsesDefault(projection)) return config;
  try {
    const outcome = mutatePersistedConfig(fresh => ({
      changed: migrateXaiResponsesDefault(fresh),
      value: fresh,
    }));
    if (outcome.status !== "unavailable") return outcome.value;
    console.warn(`[xai-responses-migration] Persistence unavailable (${outcome.reason}); using Responses in memory only.`);
  } catch {
    // Filesystem errors can carry private paths. Startup must still remain available.
    console.warn("[xai-responses-migration] Persistence failed; using Responses in memory only.");
  }
  return projection;
}
