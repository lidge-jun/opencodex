import type { ReactNode } from "react";
import { modelLabel } from "../model-display";

/**
 * Background-helper picker options.
 *
 * This mapping used to wrap the label in `String()`, and `modelLabel()` returns
 * a ReactNode for icon-bearing slugs, so those options rendered as
 * "[object Object]" in the picker (#668). Keep the label a node —
 * `SelectOption.label` is already `ReactNode`.
 */
export function backgroundHelperOptions(
  available: readonly string[] | undefined,
  unsetLabel: string,
): { value: string; label: ReactNode }[] {
  const options = (available ?? []).map(m => ({ value: m, label: modelLabel(m) }));
  return [{ value: "", label: unsetLabel }, ...options];
}
