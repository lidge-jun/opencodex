import { existsSync, readFileSync } from "node:fs";
import { invalidateCodexModelsCache, syncCatalogModels } from "./codex-catalog";
import { CODEX_MODELS_CACHE_PATH } from "./codex-paths";
import { atomicWriteFile } from "./config";
import type { OcxConfig } from "./types";

export interface CodexCatalogRefreshResult {
  added: number;
  path: string;
  catalogExists: boolean;
  cacheSynced: boolean;
}

interface RefreshDeps {
  syncCatalogModels: typeof syncCatalogModels;
  invalidateCodexModelsCache: typeof invalidateCodexModelsCache;
  syncCodexModelsCacheFromCatalog: typeof syncCodexModelsCacheFromCatalog;
  existsSync: typeof existsSync;
}

const defaultDeps: RefreshDeps = {
  syncCatalogModels,
  invalidateCodexModelsCache,
  syncCodexModelsCacheFromCatalog,
  existsSync,
};

export function syncCodexModelsCacheFromCatalog(catalogPath: string): void {
  const content = readFileSync(catalogPath, "utf8");
  atomicWriteFile(CODEX_MODELS_CACHE_PATH, content);
}

/**
 * Rebuild Codex's on-disk model catalog and keep Codex's models cache aligned
 * when a catalog file exists. Codex Desktop can read models_cache.json directly,
 * so deleting a stale cache is not enough: the cache must be replaced with the
 * same catalog content the CLI debug path reads.
 */
export async function refreshCodexModelCatalog(
  config: OcxConfig,
  deps: RefreshDeps = defaultDeps,
): Promise<CodexCatalogRefreshResult> {
  const result = await deps.syncCatalogModels(config);
  const catalogExists = deps.existsSync(result.path);
  if (!catalogExists) return { ...result, catalogExists, cacheSynced: false };
  deps.invalidateCodexModelsCache();
  deps.syncCodexModelsCacheFromCatalog(result.path);
  return { ...result, catalogExists, cacheSynced: true };
}
