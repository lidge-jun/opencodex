import { mutatePersistedConfig } from "../config";
import { migrateSubagentModels } from "../config/subagent-models";
import type { OcxConfig } from "../types";

/** Rebase the upgrade on disk so another startup cannot shift the roster twice. */
export function migrateStartupSubagentModels(config: OcxConfig): void {
  const projection = { ...config };
  if (!migrateSubagentModels(projection)) return;
  let next = projection;
  try {
    const outcome = mutatePersistedConfig(fresh => ({
      changed: migrateSubagentModels(fresh),
      value: fresh,
    }));
    if (outcome.status === "unavailable") {
      console.warn(`[subagent-models-migration] Persistence unavailable (${outcome.reason}); using the upgraded roster in memory only.`);
    } else {
      next = outcome.value;
    }
  } catch {
    // A contended coordinator or failed atomic write must not prevent proxy startup.
    // Do not log the exception: filesystem errors may contain private paths.
    console.warn("[subagent-models-migration] Persistence failed; using the upgraded roster in memory only.");
  }
  config.subagentModels = next.subagentModels;
  config.subagentModelsVersion = next.subagentModelsVersion;
}
