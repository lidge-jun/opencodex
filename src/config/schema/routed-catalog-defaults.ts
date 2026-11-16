import * as z from "zod/v4";
import type { OcxConfig } from "../../types";
import type { OcxRoutedCatalogDefaultsConfig } from "../../types/routed-catalog-defaults";

/**
 * Operator defaults for routed Codex catalog rows (#6872), stored as top-level
 * `routedCatalogDefaults` in config.json.
 *
 * The allowlist is the owner's decision: the three `include_*_usage_instructions` prompt-block
 * flags plus `support_verbosity` / `default_verbosity`. Nothing else is accepted, because the
 * neighbouring row fields (tool mode, search, truncation, auto review, identity) carry execution or
 * protocol contracts that an operator default must not be able to undo. Every field is optional;
 * an omitted field keeps today's derivation, and explicit `false` stays `false`.
 */
export const ROUTED_CATALOG_VERBOSITIES = ["low", "medium", "high"] as const;

export const routedCatalogDefaultsSchema = z.object({
  includeSkillsUsageInstructions: z.boolean().optional(),
  includeAppsUsageInstructions: z.boolean().optional(),
  includePluginUsageInstructions: z.boolean().optional(),
  supportVerbosity: z.boolean().optional(),
  defaultVerbosity: z.enum(ROUTED_CATALOG_VERBOSITIES).optional(),
}).strict() satisfies z.ZodType<OcxRoutedCatalogDefaultsConfig>;

export type RoutedCatalogDefaults = OcxRoutedCatalogDefaultsConfig;

export const ROUTED_CATALOG_DEFAULTS_SHAPE_HINT = "accepts only optional boolean includeSkillsUsageInstructions,"
  + " includeAppsUsageInstructions, includePluginUsageInstructions and supportVerbosity, and an optional"
  + " defaultVerbosity of \"low\", \"medium\" or \"high\"";

/** Write-boundary check; also drives the load-time and diagnostics warnings for a degraded block. */
export function routedCatalogDefaultsConfigError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const block = (value as Record<string, unknown>).routedCatalogDefaults;
  return block === undefined || routedCatalogDefaultsSchema.safeParse(block).success
    ? null : "schema_invalid: routedCatalogDefaults: " + ROUTED_CATALOG_DEFAULTS_SHAPE_HINT;
}

/**
 * Capture the defaults once per catalog build. Catalog derivation receives this frozen snapshot as
 * an input instead of reading mutable config while it derives rows. A malformed synthetic value
 * resolves the same way as a degraded disk block, and an empty block is the same as no block.
 */
export function resolveRoutedCatalogDefaults(
  config: Pick<OcxConfig, "routedCatalogDefaults">,
): Readonly<RoutedCatalogDefaults> | undefined {
  const parsed = routedCatalogDefaultsSchema.safeParse(config.routedCatalogDefaults);
  if (!parsed.success || Object.keys(parsed.data).length === 0) return undefined;
  return Object.freeze({ ...parsed.data });
}
