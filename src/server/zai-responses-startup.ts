import { mutatePersistedConfig } from "../config";
import { migrateZaiResponsesDefault } from "../providers/zai-responses-migration";
import type { OcxConfig } from "../types";

/** Rebase the one-time Z.AI wire upgrade before initializing any live config consumers. */
export function migrateStartupZaiResponses(config: OcxConfig): OcxConfig {
  const projection = { ...config };
  if (!migrateZaiResponsesDefault(projection)) return config;
  try {
    const outcome = mutatePersistedConfig(fresh => ({
      changed: migrateZaiResponsesDefault(fresh),
      value: fresh,
    }));
    if (outcome.status !== "unavailable") return outcome.value;
    console.warn(`[zai-responses-migration] Persistence unavailable (${outcome.reason}); using Responses in memory only.`);
  } catch {
    // Filesystem errors can carry private paths. Startup must still remain available.
    console.warn("[zai-responses-migration] Persistence failed; using Responses in memory only.");
  }
  return projection;
}
