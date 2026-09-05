import type { OcxConfig } from "../types";
import { NATIVE_GPT6_ASTRA_MODEL } from "../codex/catalog/native-models";

export const SUBAGENT_MODELS_VERSION = 1;

/** Native featured defaults; Codex advertises at most five picker-visible rows. */
export const DEFAULT_SUBAGENT_MODELS = [
  NATIVE_GPT6_ASTRA_MODEL, "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
];

/** One-time upgrade; later user edits (including removing Astra) remain authoritative. */
export function migrateSubagentModels(config: OcxConfig): boolean {
  if ((config.subagentModelsVersion ?? 0) >= SUBAGENT_MODELS_VERSION) return false;
  if (config.subagentModels === undefined) {
    config.subagentModels = [...DEFAULT_SUBAGENT_MODELS];
  } else {
    const retained = [...new Set([NATIVE_GPT6_ASTRA_MODEL, ...config.subagentModels])].slice(0, 5);
    // Cap first: do not rescue a fifth old choice. Retained 5.5 belongs at the bottom.
    config.subagentModels = retained.filter(model => model !== "gpt-5.5");
    if (retained.includes("gpt-5.5")) config.subagentModels.push("gpt-5.5");
  }
  config.subagentModelsVersion = SUBAGENT_MODELS_VERSION;
  return true;
}
