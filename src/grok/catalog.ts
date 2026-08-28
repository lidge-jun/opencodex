import { comboPublicModelId } from "../combos";
import {
  filterCatalogVisibleModels,
  nativeContextLimits,
  nativeOpenAiContextWindow,
  nativeOpenAiSlugs,
  visibleNativeSlugs,
  type CatalogModel,
} from "../codex/catalog";
import type { OcxConfig } from "../types";
import type { GrokInjectModel } from "./inject";

export interface GrokCatalogProjection {
  models: GrokInjectModel[];
  catalogModelIds: ReadonlySet<string>;
  disabledProviderNamespaces: ReadonlySet<string>;
  comboPublicModelIds: ReadonlySet<string>;
}

/**
 * Project one fetched catalog into both emitted Grok rows and orphan-classification evidence.
 * Keeping this shared prevents `ocx start` and the management toggle from disagreeing.
 */
export function projectGrokCatalog(
  allRouted: CatalogModel[],
  config: OcxConfig,
): GrokCatalogProjection {
  const routed = filterCatalogVisibleModels(allRouted, config);
  const limits = nativeContextLimits(config);
  return {
    catalogModelIds: new Set([
      ...nativeOpenAiSlugs(),
      ...allRouted.map(model => model.alias ?? `${model.provider}/${model.id}`),
    ]),
    disabledProviderNamespaces: new Set(
      Object.entries(config.providers)
        .filter(([, provider]) => provider?.disabled === true)
        .map(([name]) => name),
    ),
    comboPublicModelIds: new Set(
      Object.entries(config.combos ?? {})
        .map(([id, combo]) => comboPublicModelId(id, combo)),
    ),
    models: [
      ...visibleNativeSlugs(config).map(id => {
        const contextWindow = nativeOpenAiContextWindow(id, limits);
        return { id, ...(contextWindow !== undefined ? { contextWindow } : {}) };
      }),
      ...routed.map(model => ({
        id: model.alias ?? `${model.provider}/${model.id}`,
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      })),
    ],
  };
}
