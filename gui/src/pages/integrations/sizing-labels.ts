import type { TKey } from "../../i18n/shared";

export type SizingTier = "fast" | "standard" | "frontier";
export type SizingEffortIntent = "glance" | "measured" | "thorough" | "exhaustive";

export const TIER_LABEL: Record<SizingTier, TKey> = {
  fast: "integrations.lazycodexRoles.auto.tierFast",
  standard: "integrations.lazycodexRoles.auto.tierStandard",
  frontier: "integrations.lazycodexRoles.auto.tierFrontier",
};

export const EFFORT_LABEL: Record<SizingEffortIntent, TKey> = {
  glance: "integrations.lazycodexRoles.auto.effortGlance",
  measured: "integrations.lazycodexRoles.auto.effortMeasured",
  thorough: "integrations.lazycodexRoles.auto.effortThorough",
  exhaustive: "integrations.lazycodexRoles.auto.effortExhaustive",
};
