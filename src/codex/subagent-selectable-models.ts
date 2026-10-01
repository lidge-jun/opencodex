import type { OcxConfig } from "../types";
import { slugEquals } from "../providers/slug-codec";
import { catalogModelSlug, type CatalogModel } from "./catalog";

/**
 * The models a subagent can be pinned to: enabled native slugs first, then visible routed
 * models, then any saved roster slot that has since gone out of view.
 *
 * One list behind both the dashboard's subagent roster and role-model pickers
 * (GET /api/subagent-models) and the role auto-assign candidates, so a proposal can only name a
 * model the picker would offer. A saved roster slot stays representable after its model is
 * disabled elsewhere: the roster UI treats this list as the rows it can render, and a Save of a
 * list missing that slot would silently truncate the persisted roster.
 */
export function subagentSelectableModels(
  config: Pick<OcxConfig, "disabledModels" | "subagentModels">,
  models: readonly CatalogModel[],
  nativeSlugs: readonly string[],
): string[] {
  const disabled = new Set(config.disabledModels ?? []);
  const visibleRouted = [...new Set(models
    .filter(m => ![...disabled].some(stored =>
      stored === catalogModelSlug(m) || slugEquals(stored, m.provider, m.id)
    ))
    .map(catalogModelSlug))];
  const selectable = [...nativeSlugs.filter(ns => !disabled.has(ns)), ...visibleRouted];
  const selectableSet = new Set(selectable);
  return [
    ...selectable,
    ...[...new Set(config.subagentModels ?? [])].filter(model => !selectableSet.has(model)),
  ];
}
