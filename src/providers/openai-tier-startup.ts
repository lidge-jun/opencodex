import {
  backupConfigBeforeOpenAiTierMigration,
  OpenAiTierBackupCollisionError,
  OpenAiTierRollbackPreserveError,
  preserveOpenAiTierRollbackSnapshot,
  saveConfig,
} from "../config";
import type { OcxConfig } from "../types";
import { projectOpenAiTierMigration } from "./openai-tiers";

export interface OpenAiTierStartupDeps {
  project: typeof projectOpenAiTierMigration;
  backup: () => void;
  save: (config: OcxConfig) => void;
  preserveRollback?: (error: OpenAiTierBackupCollisionError) => void;
}

function defaultPreserveRollback(error: OpenAiTierBackupCollisionError): void {
  if (!error.configPath) throw error;
  try {
    const preserved = preserveOpenAiTierRollbackSnapshot(error.configPath);
    console.warn(`[openai-provider-migration] Preserved rollback snapshot at ${preserved}`);
  } catch (cause) {
    if (
      cause instanceof OpenAiTierRollbackPreserveError
      && (cause.code === "missing" || cause.code === "not-rollback")
    ) {
      throw error;
    }
    throw cause;
  }
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
  try {
    deps.backup();
  } catch (error) {
    if (!(error instanceof OpenAiTierBackupCollisionError)) throw error;
    (deps.preserveRollback ?? defaultPreserveRollback)(error);
    deps.backup();
  }
  deps.save(projection.config);
  for (const warning of projection.warnings) console.warn(`[openai-provider-migration] ${warning}`);
  return projection.config;
}
