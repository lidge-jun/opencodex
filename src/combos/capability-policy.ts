import { codexEffortRank } from "../reasoning-effort";
import type { OcxComboCapabilityPolicy, OcxComboReasoningEffortMode } from "../types";

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
