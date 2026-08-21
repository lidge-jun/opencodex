/**
 * Operator-supplied display labels for live-discovered provider models (#2201).
 *
 * A discovered row's label is its routed slug, so NVIDIA NIM surfaces as
 * `nvidia/deepseek-ai-deepseek-v4-flash-0731` in the picker, the dashboard,
 * `/v1/models`, and client exports. `customModels[].displayName` and combo
 * display labels already relabel their rows display-only; live discovery is the
 * one row source with no equivalent.
 *
 * The single invariant: a display label is never routing identity. Nothing here
 * touches `provider`, `id`, or the routed slug — the resolved label lands on
 * `CatalogModel.displayName`, which `applyCatalogModelMetadata` already treats
 * as display-only, and which client exports already read.
 */

import { COMBO_NAMESPACE } from "../../combos/types";
import type { OcxConfig } from "../../types/config";
import type { CatalogModel } from "./parsing";

/** Same bound as the combo display label (src/combos/types.ts) so every label surface agrees. */
export const MAX_DISPLAY_LABEL_LENGTH = 128;

// Control characters corrupt picker rendering, so a label carrying one is rejected.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * A label is usable when it is a non-empty single-line string within the shared bound.
 *
 * Slashes are rejected, matching the `customModels[].displayName` rule: a label
 * containing `/` reads as a routed slug, and this field must never be mistaken
 * for one.
 */
export function isValidDisplayLabel(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DISPLAY_LABEL_LENGTH) return false;
  if (CONTROL_CHARS.test(trimmed)) return false;
  return !trimmed.includes("/");
}

/**
 * The precedence chain, in one place:
 *
 *   1. operator override — `providers[<provider>].modelDisplayNames[<native id>]`
 *   2. trusted discovery metadata — a label discovery already attached
 *   3. undefined — caller keeps its derived slug, i.e. today's behaviour
 *
 * Combo rows are skipped: they validate their own bounded label independently, so
 * an entry under the combo namespace must not be relabelled from provider config.
 * Native OpenAI rows never reach here at all — they come from the pinned snapshot
 * path with no `CatalogModel` — so upstream marketing names stay untouched.
 */
export function resolveModelDisplayLabel(
  config: OcxConfig,
  model: CatalogModel,
): string | undefined {
  if (model.provider === COMBO_NAMESPACE) {
    return isValidDisplayLabel(model.displayName) ? model.displayName.trim() : undefined;
  }
  const override = config.providers?.[model.provider]?.modelDisplayNames?.[model.id];
  if (isValidDisplayLabel(override)) return override.trim();
  if (isValidDisplayLabel(model.displayName)) return model.displayName.trim();
  return undefined;
}

/**
 * Resolve labels across a discovered model list.
 *
 * Returns the input array unchanged when nothing resolves, and otherwise a new
 * array of new objects — the input models are never mutated, so a caller holding
 * the pre-label list keeps it intact.
 */
export function applyOperatorDisplayLabels(
  models: CatalogModel[],
  config: OcxConfig,
): CatalogModel[] {
  let changed = false;
  const labeled = models.map(model => {
    const label = resolveModelDisplayLabel(config, model);
    if (label === undefined || label === model.displayName) return model;
    changed = true;
    return { ...model, displayName: label };
  });
  return changed ? labeled : models;
}
