import type { TKey } from "../../i18n/shared";

export type SizingTier = "fast" | "standard" | "frontier";
export type SizingEffortIntent = "glance" | "measured" | "thorough" | "exhaustive";

export const TIER_LABEL: Record<SizingTier, TKey> = {
  fast: "integrations.omoRoles.auto.tierFast",
  standard: "integrations.omoRoles.auto.tierStandard",
  frontier: "integrations.omoRoles.auto.tierFrontier",
};

export const EFFORT_LABEL: Record<SizingEffortIntent, TKey> = {
  glance: "integrations.omoRoles.auto.effortGlance",
  measured: "integrations.omoRoles.auto.effortMeasured",
  thorough: "integrations.omoRoles.auto.effortThorough",
  exhaustive: "integrations.omoRoles.auto.effortExhaustive",
};
