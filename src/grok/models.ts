import {
  filterCatalogVisibleModels,
  nativeContextLimits,
  nativeDefaultReasoningEffort,
  nativeOpenAiContextWindow,
  nativeReasoningEfforts,
  visibleNativeSlugs,
  type CatalogModel,
} from "../codex/catalog";
import type { OcxConfig } from "../types";
import type { GrokInjectModel } from "./inject";

/**
 * Catalog → inject payload used by both `syncGrokConfig` and the dashboard enable
 * path. Native rows carry the pinned ladder; routed rows carry
 * `reasoningEfforts` / `defaultReasoningEffort`. The writer sanitizes Grok-invalid
 * rungs — this function forwards the same lists `/v1/models` already advertises.
 */
export function buildGrokInjectModels(
  config: Pick<OcxConfig, "disabledModels" | "combos" | "providers" | "providerContextCaps">,
  routed: CatalogModel[],
): GrokInjectModel[] {
  const contextLimits = nativeContextLimits(config);
  return [
    ...visibleNativeSlugs(config).map(id => {
      const contextWindow = nativeOpenAiContextWindow(id, contextLimits);
      const reasoningEfforts = nativeReasoningEfforts(id);
      const defaultReasoningEffort = nativeDefaultReasoningEffort(id);
      return {
        id,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
        ...(defaultReasoningEffort !== undefined ? { defaultReasoningEffort } : {}),
      };
    }),
    ...routed.map(model => {
      const efforts = model.reasoningEfforts ?? [];
      return {
        id: model.alias ?? `${model.provider}/${model.id}`,
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
        ...(model.defaultReasoningEffort !== undefined
          ? { defaultReasoningEffort: model.defaultReasoningEffort }
          : {}),
      };
    }),
  ];
}

/** Visible routed catalog, then the shared inject list. */
export function grokInjectModelsFromCatalog(
  config: OcxConfig,
  catalog: CatalogModel[],
): GrokInjectModel[] {
  return buildGrokInjectModels(config, filterCatalogVisibleModels(catalog, config));
}
