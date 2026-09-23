import type { OcxConfig } from "../types";
import { NATIVE_GPT6_ASTRA_MODEL, NATIVE_GPT6_LUNA_MODEL, NATIVE_GPT6_SOL_MODEL } from "../codex/catalog/native-models";

export const SUBAGENT_MODELS_VERSION = 2;

/** Native featured defaults: the GPT-6 trio. Codex advertises at most five picker-visible rows. */
export const DEFAULT_SUBAGENT_MODELS = [NATIVE_GPT6_ASTRA_MODEL, NATIVE_GPT6_SOL_MODEL, NATIVE_GPT6_LUNA_MODEL];

/** The version-1 generated default. Only this exact list, in this order, moves to the trio. */
const V1_DEFAULT_SUBAGENT_MODELS = [NATIVE_GPT6_ASTRA_MODEL, "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];

function isV1DefaultRoster(models: readonly string[]): boolean {
  return models.length === V1_DEFAULT_SUBAGENT_MODELS.length
    && models.every((model, index) => model === V1_DEFAULT_SUBAGENT_MODELS[index]);
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
  // Version 2 replaces only the untouched generated default; an edited list is the user's.
  if (config.subagentModels !== undefined && isV1DefaultRoster(config.subagentModels)) {
    config.subagentModels = [...DEFAULT_SUBAGENT_MODELS];
  }
  config.subagentModelsVersion = SUBAGENT_MODELS_VERSION;
  return true;
}
