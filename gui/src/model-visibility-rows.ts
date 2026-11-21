/**
 * One on/off rule for a model row, shared by every surface that toggles model visibility: the
 * Models catalog, the Models "Overall" tab and the provider Models tab.
 *
 * Visibility is the final answer Codex sees: the provider allowlist admits the row AND the
 * shared disabled list does not name it. The disabled list is read as a set of namespaced keys
 * built from ALL rows (collectDisabledNamespaced), exactly as the catalog has always read it,
 * so two surfaces fed the same rows cannot disagree about one model.
 */
import { modelVisible, type ModelVisibilityTarget, type ProviderModelMap } from "./model-visibility";
import type { ModelRow } from "./pages/models-shared";

export type VisibilityRow = Pick<ModelRow, "provider" | "id" | "namespaced" | "native">;

/** The persisted answer, before any optimistic draft. */
export function savedRowVisible(selected: ProviderModelMap, disabled: ReadonlySet<string>, row: VisibilityRow): boolean {
  return modelVisible(selected, row.provider, row.id, row.native === true, disabled.has(row.namespaced));
}

/** The PUT /api/model-visibility target for a row. */
export function rowVisibilityTarget(row: VisibilityRow): ModelVisibilityTarget {
  return { id: row.id, native: row.native === true };
}

/** The switch's accessible name: the identifier Codex shows, constant across states. */
export function rowVisibilityLabel(row: VisibilityRow): string {
  return row.native ? row.id : row.namespaced;
}

