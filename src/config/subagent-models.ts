import type { OcxConfig } from "../types";
import { NATIVE_GPT6_ASTRA_MODEL, NATIVE_GPT6_LUNA_MODEL, NATIVE_GPT6_SOL_MODEL } from "../codex/catalog/native-models";

export const SUBAGENT_MODELS_VERSION = 2;

/** Native featured defaults: the GPT-6 trio. Codex advertises at most five picker-visible rows. */
export const DEFAULT_SUBAGENT_MODELS = [NATIVE_GPT6_ASTRA_MODEL, NATIVE_GPT6_SOL_MODEL, NATIVE_GPT6_LUNA_MODEL];

/** Bare native families the version-2 upgrade removes from a roster. */
const RETIRED_ROSTER_FAMILY = /^gpt-5\.[56](?:-|$)/;
/** Retired rows whose GPT-6 successor takes their place. */
const ROSTER_SUCCESSORS: ReadonlyMap<string, string> = new Map([
  ["gpt-5.6-sol", NATIVE_GPT6_SOL_MODEL],
  ["gpt-5.6-luna", NATIVE_GPT6_LUNA_MODEL],
]);
const SUCCESSOR_IDS = new Set(ROSTER_SUCCESSORS.values());

/**
 * Replace Sol/Luna with their GPT-6 rows and drop every other bare 5.5/5.6 id, in place order.
 * Ids with a "/" name a routed or account-qualified target and keep their exact spelling.
 * A list that only held retired rows receives the defaults instead of becoming empty.
 */
function upgradeRetiredRosterRows(models: readonly string[]): string[] {
  const upgraded: string[] = [];
  for (const model of models) {
    const next = ROSTER_SUCCESSORS.get(model) ?? (RETIRED_ROSTER_FAMILY.test(model) ? null : model);
    if (next === null || (SUCCESSOR_IDS.has(next) && upgraded.includes(next))) continue;
    upgraded.push(next);
  }
  return upgraded.length === 0 && models.length > 0 ? [...DEFAULT_SUBAGENT_MODELS] : upgraded;
}

/** One-time upgrades; later user edits (including removing Astra) remain authoritative. */
export function migrateSubagentModels(config: OcxConfig): boolean {
  const version = config.subagentModelsVersion ?? 0;
  if (version >= SUBAGENT_MODELS_VERSION) return false;
  if (version < 1) {
    if (config.subagentModels === undefined) {
      config.subagentModels = [...DEFAULT_SUBAGENT_MODELS];
    } else {
      const retained = [...new Set([NATIVE_GPT6_ASTRA_MODEL, ...config.subagentModels])].slice(0, 5);
      // Cap first: do not rescue a fifth old choice. Retained 5.5 belongs at the bottom.
      config.subagentModels = retained.filter(model => model !== "gpt-5.5");
      if (retained.includes("gpt-5.5")) config.subagentModels.push("gpt-5.5");
    }
  }
  if (config.subagentModels !== undefined) config.subagentModels = upgradeRetiredRosterRows(config.subagentModels);
  config.subagentModelsVersion = SUBAGENT_MODELS_VERSION;
  return true;
}
