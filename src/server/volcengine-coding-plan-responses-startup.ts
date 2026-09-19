import { mutatePersistedConfig } from "../config";
import { migrateVolcengineCodingPlanResponsesDefault } from "../providers/volcengine-coding-plan-responses-migration";
import type { OcxConfig } from "../types";

/** Rebase the one-time Volcengine Coding Plan wire upgrade before live consumers initialize. */
export function migrateStartupVolcengineCodingPlanResponses(config: OcxConfig): OcxConfig {
  const projection = { ...config };
  if (!migrateVolcengineCodingPlanResponsesDefault(projection)) return config;
  try {
    const outcome = mutatePersistedConfig(fresh => ({
      changed: migrateVolcengineCodingPlanResponsesDefault(fresh),
      value: fresh,
    }));
    if (outcome.status !== "unavailable") return outcome.value;
    console.warn("[volcengine-coding-plan-responses-migration] Persistence unavailable; using Responses in memory only.");
  } catch {
    console.warn("[volcengine-coding-plan-responses-migration] Persistence failed; using Responses in memory only.");
  }
  return projection;
}
