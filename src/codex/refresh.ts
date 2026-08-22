import { existsSync, readFileSync } from "node:fs";
import { invalidateCodexModelsCache, syncCatalogModels } from "./catalog";
import type { ComboCatalogOmission } from "./catalog/aggregation";
import { CODEX_MODELS_CACHE_PATH } from "./paths";
import { atomicWriteFile } from "../config";
import type { OcxConfig } from "../types";
import type { CodexCatalogSyncOptions } from "./catalog/sync";

export interface CodexCatalogRefreshResult {
  added: number;
  path: string;
  catalogExists: boolean;
  catalogWritten: boolean;
  cacheSynced: boolean;
  comboOmissions: ComboCatalogOmission[];
  /** Desired OFF observed under K during the catalog commit; no cache write either. */
  skippedReason?: "desired_disabled";
}

interface RefreshDeps {
  syncCatalogModels: typeof syncCatalogModels;
  invalidateCodexModelsCache: typeof invalidateCodexModelsCache;
  existsSync: typeof existsSync;
}

const defaultDeps: RefreshDeps = {
  syncCatalogModels,
  invalidateCodexModelsCache,
  existsSync,
};

export function syncCodexModelsCacheFromCatalog(catalogPath: string): void {
  const content = readFileSync(catalogPath, "utf8");
  atomicWriteFile(CODEX_MODELS_CACHE_PATH, content);
}

/**
 * Rebuild Codex's on-disk model catalog and force Codex's models cache stale
 * when a catalog file exists. The cache must keep Codex's fetched_at/client_version
 * wrapper shape; writing the raw catalog back here makes app-server/TUI refreshes
 * inconsistent with the CLI models-manager cache path.
 */
export async function refreshCodexModelCatalog(
  config: OcxConfig,
  deps: RefreshDeps = defaultDeps,
  options?: CodexCatalogSyncOptions,
): Promise<CodexCatalogRefreshResult> {
  const result = await deps.syncCatalogModels(config, options);
  const catalogExists = deps.existsSync(result.path);
  const catalogWritten = result.catalogWritten === true;
  const comboOmissions = result.comboOmissions ?? [];
  if (result.skippedReason === "desired_disabled") {
    // The commit path observed OFF under K. Invalidate nothing: rewriting the
    // models cache here would be exactly the routed-cache write the skip refused.
    return { ...result, catalogExists, catalogWritten: false, cacheSynced: false, comboOmissions };
  }
  if (!catalogExists) {
    return { ...result, catalogExists, catalogWritten: false, cacheSynced: false, comboOmissions };
  }
  const cacheSynced = deps.invalidateCodexModelsCache(options);
  return { ...result, catalogExists, catalogWritten, cacheSynced, comboOmissions };
}
