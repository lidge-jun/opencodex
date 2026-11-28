import { codexEffortRank } from "../reasoning-effort";
import type { OcxComboCapabilityPolicy, OcxComboContextWindowPolicy, OcxComboReasoningEffortMode } from "../types";

/** Distinct values across every list, in first-seen order. */
export function unionStrings(values: readonly (readonly string[])[]): string[] {
  return [...new Set(values.flat())];
}

/** Distinct rungs across every ladder; known rungs sort by rank, unknown ones keep first-seen order last. */
export function unionEfforts(ladders: readonly (readonly string[])[]): string[] {
  const rank = (effort: string): number => {
    const value = codexEffortRank(effort);
    return value < 0 ? Number.MAX_SAFE_INTEGER : value;
  };
  return unionStrings(ladders)
    .map((effort, index) => ({ effort, index }))
    .sort((a, b) => rank(a.effort) - rank(b.effort) || a.index - b.index)
    .map(item => item.effort);
}

/**
 * Whether a combo advertises the union of its members' effort ladders. Only `union` combos in
 * `adaptive` mode do: `strict` still promises that every member serves the advertised rung as
 * is, and dispatch snaps a caller rung to each member's ladder (`clampComboCallerEffort`).
 */
export function comboAdvertisesEffortUnion(
  policy: OcxComboCapabilityPolicy | undefined,
  mode: OcxComboReasoningEffortMode,
): boolean {
  return policy === "union" && mode === "adaptive";
}

/** Sparse normalizer for `contextWindowPolicy`: default `"min"` is omitted. */
export function normalizeComboContextWindowPolicy(
  value: unknown,
): Extract<OcxComboContextWindowPolicy, "max"> | undefined {
  return value === "max" ? "max" : undefined;
}

/** Effective catalog context-window policy for a combo (`"min"` when omitted). */
export function comboContextWindowPolicy(
  combo: { contextWindowPolicy?: OcxComboContextWindowPolicy } | undefined,
): OcxComboContextWindowPolicy {
  return combo?.contextWindowPolicy === "max" ? "max" : "min";
}

/** Whether a combo advertises its largest member's context window instead of the minimum. */
export function comboAdvertisesMaxContextWindow(
  policy: OcxComboCapabilityPolicy | undefined,
  contextWindowPolicy: OcxComboContextWindowPolicy | undefined,
): boolean {
  return policy === "union" && contextWindowPolicy === "max";
}
