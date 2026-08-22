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
import { CODEX_CUSTOM_MODEL_CATALOG_KIND } from "./parsing";
import type { CatalogModel } from "./parsing";

/** Same bound as the combo display label (src/combos/types.ts) so every label surface agrees. */
export const MAX_DISPLAY_LABEL_LENGTH = 128;

// Control characters corrupt picker rendering, so a label carrying one is rejected.
// The range is C0, DEL, and C1 (U+0080-U+009F). C1 was originally missing, which let
// a label such as `Label<U+0085>More` through — U+0085 is NEL, a line break, and
// `trim()` does not touch a mid-string one. U+2028/U+2029 are added for the same
// reason: they are line and paragraph separators, so a label carrying one is not
// single-line whatever its width.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Checked against the *untrimmed* value, unlike `CONTROL_CHARS`.
 *
 * `trim()` counts U+2028/U+2029 as whitespace and would strip an edge one, so a
 * trailing line separator would otherwise be normalised away and reported as
 * valid. A stray space or newline is plausible slop in a hand-edited config and
 * is still forgiven; a Unicode line separator is not, so it is rejected wherever
 * it appears rather than quietly removed.
 */
const CONTROLS_TRIM_WOULD_HIDE = /[\u0080-\u009f\u2028\u2029]/;

/**
 * A label is usable when it is a non-empty single-line string within the shared bound.
 *
 * Slashes are rejected, matching the `customModels[].displayName` rule: a label
 * containing `/` reads as a routed slug, and this field must never be mistaken
 * for one.
 */
export function isValidDisplayLabel(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (CONTROLS_TRIM_WOULD_HIDE.test(value)) return false;
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
 * Rows that already own an operator-supplied label keep it, and the provider map
 * must not outrank them:
 *   - combo rows validate their own bounded label independently, so an entry under
 *     the combo namespace is never relabelled from provider config;
 *   - an explicit `customModels[]` row carries the label the operator typed there,
 *     and #2201 requires those to continue unchanged. Matching on `catalogKind`
 *     rather than on the provider name is what makes that hold, because a custom
 *     model shares its provider with the discovered rows this function exists for.
 *
 * Native OpenAI rows never reach here at all — they come from the pinned snapshot
 * path with no `CatalogModel` — so upstream marketing names stay untouched.
 */
export function resolveModelDisplayLabel(
  config: OcxConfig,
  model: CatalogModel,
): string | undefined {
  if (model.provider === COMBO_NAMESPACE || model.catalogKind === CODEX_CUSTOM_MODEL_CATALOG_KIND) {
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
