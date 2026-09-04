import { mutatePersistedConfig } from "../config";
import { projectModelRenames } from "./model-rename-migration";
import type { OcxConfig } from "../types";

export interface ModelRenameStartupDeps {
  project: typeof projectModelRenames;
  save?: (config: OcxConfig) => void;
}

function adoptConfig(target: OcxConfig, source: OcxConfig): void {
  if (target === source) return;
  for (const key of Object.keys(target)) delete (target as unknown as Record<string, unknown>)[key];
  Object.assign(target, structuredClone(source));
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
  deps: ModelRenameStartupDeps = { project: projectModelRenames },
): OcxConfig {
  const projection = deps.project(structuredClone(config));
  if (!projection.changed) {
    for (const warning of projection.warnings) console.warn(`[model-rename-migration] ${warning}`);
    return config;
  }
  if (deps.save) {
    deps.save(projection.config);
    adoptConfig(config, projection.config);
    for (const warning of projection.warnings) console.warn(`[model-rename-migration] ${warning}`);
    return config;
  }
  const outcome = mutatePersistedConfig(fresh => {
    const next = deps.project(fresh);
    if (next.changed) adoptConfig(fresh, next.config);
    return { changed: next.changed, value: next };
  });
  if (outcome.status === "unavailable") {
    throw new Error(`model rename startup persistence unavailable: ${outcome.reason}`);
  }
  adoptConfig(config, outcome.value.config);
  for (const warning of outcome.value.warnings) console.warn(`[model-rename-migration] ${warning}`);
  return config;
}
