import { saveConfig } from "../config";
import { backupConfigBeforeAlibabaRegionMigration } from "./alibaba-region-backup";
import { projectAlibabaRegionMigration } from "./alibaba-region-migration";
import type { OcxConfig } from "../types";

export interface AlibabaRegionStartupDeps {
  project: typeof projectAlibabaRegionMigration;
  backup: () => void;
  save: (config: OcxConfig) => void;
}

/**
 * Run the #457 recovery migration at startup.
 *
 * Fail-closed: a backup failure throws, and nothing between here and
 * `startServer` catches it, so the proxy does not start rather than rewriting
 * credentials without a rollback point. That is the same posture the OpenAI tier
 * migration takes.
 */
export function runAlibabaRegionStartupMigration(
  config: OcxConfig,
  deps: AlibabaRegionStartupDeps = {
    project: projectAlibabaRegionMigration,
    backup: () => { backupConfigBeforeAlibabaRegionMigration(); },
    save: saveConfig,
  },
): OcxConfig {
  const projection = deps.project(config);
  // Warnings are emitted even on a no-op: the collision case IS the warning.
  for (const warning of projection.warnings) console.warn(`[alibaba-region-migration] ${warning}`);
  if (!projection.changed) return projection.config;
  // Strictly before the save: the snapshot must describe the config as it was.
  deps.backup();
  deps.save(projection.config);
  return projection.config;
}
