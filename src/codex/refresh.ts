import { existsSync, readFileSync } from "node:fs";
import { invalidateCodexModelsCache, syncCatalogModels } from "./catalog";
import { CODEX_MODELS_CACHE_PATH } from "./paths";
import { atomicWriteFile } from "../config";
import type { OcxConfig } from "../types";

export interface CodexCatalogRefreshResult {
  added: number;
  path: string;
  catalogExists: boolean;
  cacheSynced: boolean;
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
): Promise<CodexCatalogRefreshResult> {
  const result = await deps.syncCatalogModels(config);
  const catalogExists = deps.existsSync(result.path);
  if (!catalogExists) return { ...result, catalogExists, cacheSynced: false };
  deps.invalidateCodexModelsCache();
  return { ...result, catalogExists, cacheSynced: true };
}
