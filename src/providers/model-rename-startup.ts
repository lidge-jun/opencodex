import { saveConfig } from "../config";
import { projectModelRenames } from "./model-rename-migration";
import type { OcxConfig } from "../types";

export interface ModelRenameStartupDeps {
  project: typeof projectModelRenames;
  save: (config: OcxConfig) => void;
}

/**
 * Apply registry model renames to the saved config at startup (issue #1610).
 *
 * No backup is taken, unlike the OpenAI tier and Alibaba region migrations: those
 * rewrite credentials and provider identity, where a bad projection is not
 * recoverable from the config alone. This one only rewrites model ids that the
 * registry itself no longer seeds, and the pre-migration value is a string this
 * file still names, so the change is reversible by hand.
 */
export function runModelRenameStartupMigration(
  config: OcxConfig,
  deps: ModelRenameStartupDeps = { project: projectModelRenames, save: saveConfig },
): OcxConfig {
  const projection = deps.project(config);
  for (const warning of projection.warnings) console.warn(`[model-rename-migration] ${warning}`);
  if (!projection.changed) return projection.config;
  deps.save(projection.config);
  return projection.config;
}
