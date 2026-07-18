import { backupConfigBeforeOpenAiTierMigration, saveConfig } from "../config";
import type { OcxConfig } from "../types";
import { projectOpenAiTierMigration } from "./openai-tiers";

export interface OpenAiTierStartupDeps {
  project: typeof projectOpenAiTierMigration;
  backup: () => void;
  save: (config: OcxConfig) => void;
}

const DEFAULT_DEPS: OpenAiTierStartupDeps = {
  project: projectOpenAiTierMigration,
  backup: backupConfigBeforeOpenAiTierMigration,
  save: saveConfig,
};

export function runOpenAiTierStartupMigration(
  config: OcxConfig,
  deps: OpenAiTierStartupDeps = DEFAULT_DEPS,
): OcxConfig {
  const projection = deps.project(config);
  if (!projection.changed) return projection.config;
  deps.backup();
  deps.save(projection.config);
  for (const warning of projection.warnings) console.warn(`[openai-provider-migration] ${warning}`);
  return projection.config;
}
