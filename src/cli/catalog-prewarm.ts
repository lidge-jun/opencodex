import type { OcxConfig } from "../types";

type GatherRoutedModels = (config: OcxConfig) => Promise<unknown>;

export type CatalogPrewarmDeps = {
  loadConfig?: () => OcxConfig;
  importCatalog?: () => Promise<{ gatherRoutedModels: GatherRoutedModels }>;
};

/**
 * After the listen port is bound, kick off live provider discovery so the first
 * GUI /v1/models and syncModelsToCodex share one gather flight instead of racing
 * duplicate upstream /models fetches.
 */
export function scheduleCatalogPrewarm(deps: CatalogPrewarmDeps = {}): void {
  void Promise.resolve()
    .then(async () => {
      const load = deps.loadConfig ?? (await import("../config")).loadConfig;
      const { gatherRoutedModels } = await (deps.importCatalog?.() ?? import("../codex/catalog"));
      return gatherRoutedModels(load());
    })
    .catch(() => {});
}

