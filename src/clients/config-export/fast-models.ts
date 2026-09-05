import type { OpencodeCatalogModel } from "./contracts";

const FAST_ROW_SUFFIX = "--fast";

/**
 * Expand only hub-resolved availability; older hubs without the field advertise no Fast.
 * Reserve every exact input selector before synthesis and retain the first duplicate.
 * Keep routing/capability metadata intact: only the selector, label and availability change.
 */
export function expandFastExportModels<T extends OpencodeCatalogModel>(models: readonly T[]): T[] {
  const exact = new Map<string, T>();
  for (const model of models) {
    if (!exact.has(model.namespaced)) exact.set(model.namespaced, model);
  }
  const expanded = [...exact.values()];
  for (const model of exact.values()) {
    if (model.fastRowAvailable !== true) continue;
    const namespaced = `${model.namespaced}${FAST_ROW_SUFFIX}`;
    if (exact.has(namespaced)) continue;
    expanded.push({
      ...model,
      namespaced,
      displayName: `${model.displayName || model.id || model.namespaced} Fast`,
      // Re-normalizing cannot synthesize a Fast row from this synthetic row.
      fastRowAvailable: false,
    });
  }
  return expanded;
}
